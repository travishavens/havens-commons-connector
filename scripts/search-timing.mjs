import { performance } from 'node:perf_hooks';
import { htmlToText, searchGuides, START_ID } from '../src/guides.mjs';

const count = 38;
const query = 'voice scams';
const ids = Array.from({ length: count }, (_, i) => `guide_${String(i).padStart(24, '0')}`);
const link = (id, tail) => `https://www.google.com/url?q=${encodeURIComponent(`https://docs.google.com/document/d/${id}/${tail}`)}`;
const index = `<h3>01 Guides</h3><ul>${ids.map((id, i) =>
  `<li><a href="${link(id, 'edit')}">Guide ${i}</a> | <a href="${link(id, 'export?format=txt')}">for your AI</a></li>`
).join('')}</ul>`;
const html = `<body><h1>Family guide</h1><p>${'A family plan helps identify voice scams. '.repeat(220)}</p></body>`;
const text = htmlToText(html);
const makeCache = () => {
  const entries = new Map();
  return {
    async match(key) { return entries.get(key)?.clone(); },
    async put(key, response) { entries.set(key, response.clone()); }
  };
};
const priorFetch = globalThis.fetch;
globalThis.fetch = async (url) => new Response(url.includes(START_ID) ? index : html);

const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const run = async (fn, iterations) => {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return { median_ms: Number(median(times).toFixed(3)), p95_ms: Number(times.sort((a, b) => a - b)[Math.floor(iterations * 0.95)].toFixed(3)) };
};

try {
  const cold = await run(() => searchGuides(query, makeCache(), 900), 100);
  const cache = makeCache();
  let search;
  do { search = await searchGuides(query, cache, 900); } while (search.note);
  const warm = await run(() => searchGuides(query, cache, 900), 100);
  console.log(JSON.stringify({
    fixture_guides: count, text_chars_per_guide: text.length, iterations: 100,
    cold_full_corpus: cold, warm_cached_slices: warm
  }, null, 2));
} finally {
  globalThis.fetch = priorFetch;
}
