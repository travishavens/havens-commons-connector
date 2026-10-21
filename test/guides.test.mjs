import assert from 'node:assert/strict';
import test from 'node:test';
import { START_ID, docExportUrl, getGuide, htmlToText, listGuides, operationsBudgetLimit, parseGuideIndex, rankGuides, searchGuides } from '../src/guides.mjs';

const a = '1wyTUNVHifUGc07Q_duTZJaAq4uZaVoug1WaJ67dBjLE';
const b = '1JmG_jOCPwfo4_NwdCUjY4YplCdNm1uu9DQvK0wAurJ0';
const link = (id, tail) => `https://www.google.com/url?q=${encodeURIComponent(`https://docs.google.com/document/d/${id}/${tail}`)}&sa=D`;
const index = `<h3>01 Pick your main AI</h3><ul>
  <li><a href="${link(a, 'edit')}">Start on your phone</a> | <a href="${link(a, 'export?format=txt')}">for your AI</a></li>
  <li><a href="https://elsewhere.test/document/d/${b}/edit">Outside</a></li>
  </ul><h3>06 Grandparents and families</h3><ul>
  <li><a href="${link(b, 'edit')}">AI voice scams: a family plan</a> | <a href="${link(b, 'export?format=txt')}">for your AI</a></li>
  <li><a href="${link(b, 'edit')}">duplicate</a> | <a href="${link(b, 'export?format=txt')}">for your AI</a></li></ul>`;

test('parses section, title and matching public link pairs once', () => {
  const guides = parseGuideIndex(index);
  assert.equal(guides.length, 2);
  assert.equal(guides[1].section, '06 Grandparents and families');
  assert.equal(guides[0].read_url, `https://docs.google.com/document/d/${a}/edit`);
  assert.equal(guides[0].text_url, `https://docs.google.com/document/d/${a}/export?format=txt`);
});

test('search ranks the matching title above a body-only match', () => {
  const guides = parseGuideIndex(index);
  const hits = rankGuides('voice scams', [
    { ...guides[0], text: 'Ask about voice scams in a general checklist.' },
    { ...guides[1], text: 'Keep a family call-back plan.' }
  ]);
  assert.equal(hits[0].id, b);
  assert.match(hits[1].excerpt, /voice scams/);
});

test('extracts guide text from HTML without style rules', () => {
  assert.equal(htmlToText('<style>secret {}</style><body><h1>Family plan</h1><p>Call back first.</p></body>'), 'Family plan\nCall back first.');
});

test('only an indexed ID can produce a fixed Docs export URL', async () => {
  const guides = parseGuideIndex(index);
  assert.equal(docExportUrl(a, new Set(guides.map(({ id }) => id))), `https://docs.google.com/document/d/${a}/export?format=html`);
  assert.throws(() => docExportUrl('https://evil.example/', new Set([a])));
  assert.throws(() => docExportUrl(b, new Set([a])));
  const prior = globalThis.fetch;
  globalThis.fetch = async () => new Response(index);
  try {
    await assert.rejects(getGuide('not-in-index', null), /No unique guide/);
  } finally { globalThis.fetch = prior; }
});

function fakeSource(count) {
  const guides = Array.from({ length: count }, (_, i) => ({ id: `guide_${String(i).padStart(24, '0')}`, title: `Guide ${i}` }));
  const entries = new Map();
  const guideIndex = `<h3>01 Guides</h3><ul>${guides.map(({ id, title }) =>
    `<li><a href="${link(id, 'edit')}">${title}</a> | <a href="${link(id, 'export?format=txt')}">for your AI</a></li>`
  ).join('')}</ul>`;
  const calls = { fetch: 0, match: 0, put: 0 };
  const reset = () => { calls.fetch = calls.match = calls.put = 0; };
  const snapshot = () => ({ ...calls, total: calls.fetch + calls.match + calls.put });
  const cache = {
    async match(key) {
      calls.match++;
      return entries.get(key)?.clone();
    },
    async put(key, response) {
      calls.put++;
      entries.set(key, response.clone());
    }
  };
  const fetch = async (url) => {
    calls.fetch++;
    return new Response(url.includes(START_ID) ? guideIndex : '<body><p>Voice scams need a family plan.</p></body>');
  };
  return { guides, cache, calls, reset, snapshot, fetch };
}

test('missing and invalid operation budgets use the 46-operation fallback', () => {
  for (const value of [undefined, null, '', 'abc', '46.5', 0, -1, 45, 901, '1000']) {
    assert.equal(operationsBudgetLimit(value), 46, String(value));
  }
  assert.equal(operationsBudgetLimit('900'), 900);
  assert.equal(operationsBudgetLimit(900), 900);
});

test('Free budget keeps every request within 50 operations at 38, 60, and 140 guides', async () => {
  const prior = globalThis.fetch;
  try {
    for (const count of [38, 60, 140]) {
      const source = fakeSource(count);
      globalThis.fetch = source.fetch;
      const requests = [];
      let complete = false;
      for (let i = 0; i < Math.ceil(count / 20) + 1; i++) {
        source.reset();
        const search = await searchGuides('voice scams', source.cache, 46);
        const operations = source.snapshot();
        assert.ok(operations.total <= 46, `${count} guides, request ${i + 1}: ${JSON.stringify(operations)}`);
        assert.ok(operations.total <= 50);
        assert.deepEqual(search.operations, { used: operations.total, budget: 46 });
        assert.ok(search.results.length > 0);
        requests.push(operations);
        if (search.note === null) {
          complete = true;
          break;
        }
        const searched = Math.min(i * 20 + 20, count);
        assert.match(search.note, new RegExp(`Searched ${searched} of ${count} guides;.*still warming.*Search again`, 'i'));
      }
      assert.ok(complete, `${count} guides never fully warmed`);
      source.reset();
      const warm = await searchGuides('voice scams', source.cache, 46);
      const warmOperations = source.snapshot();
      assert.equal(warm.note, null);
      assert.deepEqual(warmOperations, { fetch: 0, match: Math.ceil(count / 20), put: 0, total: Math.ceil(count / 20) });
      console.log(JSON.stringify({ guides: count, warming_requests: requests, warm: warmOperations }));
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test('Paid budget completes a cold search at 38, 140, and 425 guides within 1,000 operations', async () => {
  const prior = globalThis.fetch;
  try {
    for (const count of [38, 140, 425]) {
      const source = fakeSource(count);
      globalThis.fetch = source.fetch;
      const first = await searchGuides('voice scams', source.cache, 900);
      const operations = source.snapshot();
      assert.equal(first.note, null, `${count} guides did not complete on first search`);
      assert.equal(first.results.length, 5);
      assert.deepEqual(first.operations, { used: operations.total, budget: 900 });
      assert.ok(operations.total <= 900 && operations.total <= 1000, JSON.stringify(operations));
      source.reset();
      const warm = await searchGuides('voice scams', source.cache, 900);
      assert.equal(warm.note, null);
      assert.equal(source.snapshot().total, Math.ceil(count / 20));
      console.log(JSON.stringify({ guides: count, paid_cold: operations, paid_warm: source.snapshot() }));
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test('Paid guide cap grows beyond the Free cap', async () => {
  const source = fakeSource(426);
  const prior = globalThis.fetch;
  globalThis.fetch = source.fetch;
  try {
    await assert.rejects(searchGuides('voice scams', source.cache, 900), /Search is being resized/);
  } finally {
    globalThis.fetch = prior;
  }
});

test('index and point reads cache their own text, and a slice reuses a point read', async () => {
  const source = fakeSource(38);
  const prior = globalThis.fetch;
  globalThis.fetch = source.fetch;
  try {
    assert.equal((await listGuides(source.cache)).length, 38);
    assert.deepEqual(source.snapshot(), { fetch: 1, match: 1, put: 1, total: 3 });
    source.reset();
    assert.equal((await getGuide(source.guides[0].id, source.cache)).id, source.guides[0].id);
    assert.deepEqual(source.snapshot(), { fetch: 1, match: 3, put: 1, total: 5 });
    source.reset();
    await getGuide(source.guides[0].id, source.cache);
    assert.deepEqual(source.snapshot(), { fetch: 0, match: 2, put: 0, total: 2 });
    source.reset();
    await searchGuides('voice scams', source.cache);
    assert.equal(source.snapshot().fetch, 19, 'the first slice should reuse one cached guide');
    assert.ok(source.snapshot().total <= 46);
  } finally {
    globalThis.fetch = prior;
  }
});

test('cold and warm point paths use fewer than 46 operations', async () => {
  const source = fakeSource(38);
  const prior = globalThis.fetch;
  globalThis.fetch = source.fetch;
  try {
    await getGuide(source.guides[0].id, source.cache);
    assert.deepEqual(source.snapshot(), { fetch: 2, match: 3, put: 2, total: 7 });
    source.reset();
    await getGuide(source.guides[0].id, source.cache);
    assert.deepEqual(source.snapshot(), { fetch: 0, match: 2, put: 0, total: 2 });
    source.reset();
    await listGuides(source.cache);
    assert.deepEqual(source.snapshot(), { fetch: 0, match: 1, put: 0, total: 1 });
    console.log(JSON.stringify({ point_cold: { fetch: 2, match: 3, put: 2, total: 7 }, point_warm: { fetch: 0, match: 2, put: 0, total: 2 }, list_warm: source.snapshot() }));
  } finally {
    globalThis.fetch = prior;
  }
});

test('a search can build two missing slices when all 38 point reads have filled their cache', async () => {
  const source = fakeSource(38);
  const prior = globalThis.fetch;
  globalThis.fetch = source.fetch;
  try {
    for (const guide of source.guides) await getGuide(guide.id, source.cache);
    source.reset();
    const search = await searchGuides('voice scams', source.cache);
    assert.equal(search.note, null);
    assert.deepEqual(source.snapshot(), { fetch: 0, match: 41, put: 2, total: 43 });
    source.reset();
    assert.equal((await searchGuides('voice scams', source.cache)).note, null);
    assert.ok(source.snapshot().total <= 46);
  } finally {
    globalThis.fetch = prior;
  }
});

test('a Google failure while building a later slice returns warm results and searched count', async () => {
  const source = fakeSource(38);
  const prior = globalThis.fetch;
  globalThis.fetch = source.fetch;
  try {
    const first = await searchGuides('voice scams', source.cache);
    assert.match(first.note, /Searched 20 of 38 guides/);
    const workingFetch = source.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes(source.guides[20].id)) throw new Error('Google unavailable');
      return workingFetch(url);
    };
    source.reset();
    const partial = await searchGuides('voice scams', source.cache);
    assert.equal(partial.results.length, 5);
    assert.match(partial.note, /Searched 20 of 38 guides;.*still warming/i);
    assert.ok(source.snapshot().total <= 46);
    globalThis.fetch = workingFetch;
    source.reset();
    const complete = await searchGuides('voice scams', source.cache);
    assert.equal(complete.note, null);
    assert.ok(source.snapshot().total <= 46);
  } finally {
    globalThis.fetch = prior;
  }
});
