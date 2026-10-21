import { decodeHTML } from 'entities';

export const START_ID = '1DCs802oe4EegUbVrst5DRX7nXBHm3-hz0QroePziaCE';
const ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
const CACHE_SECONDS = 3600;
const SLICE_SIZE = 20;
const DEFAULT_OPERATIONS_BUDGET = 46;
const MAX_OPERATIONS_BUDGET = 900;
const CACHE_ROOT = 'https://commons.travishavens.com/_cache';
const INDEX_URL = `${CACHE_ROOT}/index/v1`;
const guideUrl = (id) => `${CACHE_ROOT}/guide/v1/${id}`;
const sliceUrl = (number) => `${CACHE_ROOT}/corpus/v1/${number}`;

export function operationsBudgetLimit(value) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= DEFAULT_OPERATIONS_BUDGET && parsed <= MAX_OPERATIONS_BUDGET
    ? parsed : DEFAULT_OPERATIONS_BUDGET;
}

function operationBudget(value) {
  const limit = operationsBudgetLimit(value);
  let used = 0;
  return {
    limit,
    get used() { return used; },
    get remaining() { return limit - used; },
    use() {
      if (used >= limit) throw new Error('Search is still warming. Please search again.');
      used++;
    }
  };
}

class PublicExportError extends Error {}

async function cacheMatch(cache, key, budget) {
  if (!cache) return null;
  budget?.use();
  return cache.match(key);
}

async function cachePut(cache, key, body, contentType, budget) {
  if (!cache) return;
  budget?.use();
  await cache.put(key, new Response(body, {
    headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}`, 'Content-Type': contentType }
  }));
}

export function docExportUrl(id, allowedIds) {
  if (!ID_PATTERN.test(id) || !allowedIds.has(id)) {
    throw new Error('Guide is not in the public index');
  }
  return `https://docs.google.com/document/d/${id}/export?format=html`;
}

function unwrapGoogleLink(href) {
  if (!href) return null;
  try {
    const outer = new URL(href);
    const url = outer.hostname === 'www.google.com' && outer.pathname === '/url'
      ? new URL(outer.searchParams.get('q')) : outer;
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
    const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]{20,100})\/(edit|export)$/);
    if (!match || (match[2] === 'export' && url.searchParams.get('format') !== 'txt')) return null;
    return { id: match[1], kind: match[2] };
  } catch {
    return null;
  }
}

export function parseGuideIndex(html) {
  const guides = [];
  const seen = new Set();
  const headings = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  for (let i = 0; i < headings.length; i++) {
    const section = plainFragment(headings[i][1]);
    if (!/^\d{2}\s+/.test(section)) continue;
    const content = html.slice(headings[i].index + headings[i][0].length, headings[i + 1]?.index ?? html.length);
    for (const item of content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const linked = [...item[1].matchAll(/<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].map((anchor) => ({
        label: plainFragment(anchor[3]),
        target: unwrapGoogleLink(decodeHTML(anchor[2]))
      }));
      const read = linked.find(({ target }) => target?.kind === 'edit');
      const ai = linked.find(({ target, label }) => target?.kind === 'export' && label.toLowerCase() === 'for your ai');
      if (!read || !ai || read.target.id !== ai.target.id || seen.has(read.target.id)) continue;
      const id = read.target.id;
      seen.add(id);
      guides.push({
        id,
        title: read.label,
        section,
        read_url: `https://docs.google.com/document/d/${id}/edit`,
        text_url: `https://docs.google.com/document/d/${id}/export?format=txt`
      });
    }
  }
  if (!guides.length) throw new Error('The public index has no usable guide pairs');
  return guides;
}

function plainFragment(fragment) {
  return decodeHTML(fragment.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

async function fetchPublicExport(url, budget) {
  budget?.use();
  let response;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new PublicExportError('Public Google Doc export failed');
  }
  if (!response.ok || response.redirected || response.status >= 300 && response.status < 400) {
    throw new PublicExportError(`Public Google Doc export failed (${response.status})`);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new PublicExportError('Public Google Doc export failed while reading');
  }
  if (text.length > 1_000_000) throw new PublicExportError('Public guide is too large');
  return text;
}

async function fetchIndex(cache, budget) {
  const hit = await cacheMatch(cache, INDEX_URL, budget);
  if (hit) return parseGuideIndex(await hit.text());
  const url = docExportUrl(START_ID, new Set([START_ID]));
  const html = await fetchPublicExport(url, budget);
  const guides = parseGuideIndex(html);
  await cachePut(cache, INDEX_URL, html, 'text/html; charset=utf-8', budget);
  return guides;
}

function indexVersion(guides) {
  // A changed index invalidates slices still alive from the preceding hour.
  let hash = 2166136261;
  for (const char of JSON.stringify(guides.map(({ id, title, section }) => [id, title, section]))) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return `${guides.length}-${hash >>> 0}`;
}

async function cachedSlice(cache, number, budget) {
  const hit = await cacheMatch(cache, sliceUrl(number), budget);
  return hit ? hit.json() : null;
}

async function buildSlice(guides, number, version, cache, budget) {
  const members = guides.slice(number * SLICE_SIZE, (number + 1) * SLICE_SIZE);
  const allowed = new Set(guides.map(({ id }) => id));
  const full = [];
  for (let i = 0; i < members.length; i++) {
    const guide = members[i];
    const remaining = members.length - i;
    // Reserve one fetch per remaining guide and the slice write. A point-cache
    // lookup is optional when its miss could otherwise breach the Free quota.
    const canCheckPoint = cache && budget.remaining >= remaining + 2;
    const hit = canCheckPoint ? await cacheMatch(cache, guideUrl(guide.id), budget) : null;
    let text;
    if (hit) {
      text = await hit.text();
    } else {
      const html = await fetchPublicExport(docExportUrl(guide.id, allowed), budget);
      try {
        text = htmlToText(html);
      } catch {
        throw new PublicExportError('Public Google Doc export has no usable body');
      }
    }
    full.push({ ...guide, text, search_title: normalized(guide.title), search_section: normalized(guide.section), search_text: normalized(text) });
  }
  const slice = { version, guides: number === 0 ? guides : undefined, full };
  await cachePut(cache, sliceUrl(number), JSON.stringify(slice), 'application/json; charset=utf-8', budget);
  return slice;
}

export async function listGuides(cache = globalThis.caches?.default) {
  const guides = await fetchIndex(cache);
  return guides.map(({ id, title, section, read_url, text_url }) => ({ id, title, section, read_url, text_url }));
}

export async function getGuide(input, cache = globalThis.caches?.default) {
  const guides = await fetchIndex(cache);
  const key = input.trim().toLocaleLowerCase('en');
  const exact = guides.find((guide) => guide.id === input.trim() || guide.title.toLocaleLowerCase('en') === key);
  const partial = exact ? [] : guides.filter((guide) => guide.title.toLocaleLowerCase('en').includes(key));
  const guide = exact ?? (partial.length === 1 ? partial[0] : null);
  if (!guide) throw new Error('No unique guide matches that ID or title');
  const point = await cacheMatch(cache, guideUrl(guide.id));
  if (point) return { ...guide, text: await point.text() };
  const number = Math.floor(guides.findIndex(({ id }) => id === guide.id) / SLICE_SIZE);
  const slice = await cachedSlice(cache, number);
  let text = slice?.version === indexVersion(guides)
    ? slice.full.find(({ id }) => id === guide.id)?.text : null;
  if (text == null) {
    text = htmlToText(await fetchPublicExport(docExportUrl(guide.id, new Set(guides.map((item) => item.id)))));
  }
  await cachePut(cache, guideUrl(guide.id), text, 'text/plain; charset=utf-8');
  return { ...guide, text };
}

export function htmlToText(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!body) throw new Error('Public guide export has no body');
  const text = body.replace(/<\/(?:p|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  return decodeHTML(text).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalized(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en');
}

export function rankGuides(query, fullGuides, limit = 5) {
  const phrase = normalized(query.trim());
  const words = [...new Set(phrase.match(/[a-z0-9]+/g) ?? [])];
  if (!words.length) return [];
  return fullGuides.map((guide) => {
    const title = guide.search_title ?? normalized(guide.title);
    const section = guide.search_section ?? normalized(guide.section);
    const body = guide.search_text ?? normalized(guide.text);
    let score = title.includes(phrase) ? 20 : 0;
    for (const word of words) {
      if (title.includes(word)) score += 8;
      if (section.includes(word)) score += 2;
      if (body.includes(word)) score += 1;
    }
    const firstHit = Math.min(...words.map((word) => {
      const index = body.indexOf(word);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    }));
    const start = firstHit === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, firstHit - 65);
    return { guide, score, excerpt: guide.text.slice(start, start + 230).replace(/\s+/g, ' ').trim() };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.guide.title.localeCompare(b.guide.title))
    .slice(0, limit)
    .map(({ guide, excerpt }) => ({
      id: guide.id, title: guide.title, section: guide.section,
      read_url: guide.read_url, text_url: guide.text_url, excerpt
    }));
}

export async function searchGuides(query, cache = globalThis.caches?.default, operationsBudget) {
  const budget = operationBudget(operationsBudget);
  const first = await cachedSlice(cache, 0, budget);
  const guides = first?.guides ?? await fetchIndex(cache, budget);
  // The Paid cap leaves room for an index read, slice reads and writes, and
  // one point-cache lookup plus one export fetch per guide in a cold search.
  const maxGuides = Math.max(140, Math.floor((budget.limit - 50) / 2));
  if (guides.length > maxGuides) {
    throw new Error('Search is being resized for the growing guide index. Please use list_guides for now.');
  }
  const version = indexVersion(guides);
  const count = Math.ceil(guides.length / SLICE_SIZE);
  const slices = [first?.version === version ? first : null];
  for (let number = 1; number < count; number++) {
    const slice = await cachedSlice(cache, number, budget);
    slices.push(slice?.version === version ? slice : null);
  }
  for (let number = 0; number < count; number++) {
    if (slices[number]) continue;
    const size = Math.min(SLICE_SIZE, guides.length - number * SLICE_SIZE);
    if (budget.remaining < size + Number(Boolean(cache))) break;
    try {
      slices[number] = await buildSlice(guides, number, version, cache, budget);
    } catch (error) {
      if (!(error instanceof PublicExportError)) throw error;
      break;
    }
  }
  const results = rankGuides(query, slices.flatMap((slice) => slice?.full ?? []));
  const searched = slices.reduce((total, slice) => total + (slice?.full.length ?? 0), 0);
  return {
    results,
    operations: { used: budget.used, budget: budget.limit },
    note: slices.some((slice) => !slice)
      ? `Searched ${searched} of ${guides.length} guides; the index is still warming. Search again for full results.`
      : null
  };
}
