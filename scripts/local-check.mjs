import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:8794/mcp');
const client = new Client({ name: 'commons-local-check', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(url));

try {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['get_guide', 'list_guides', 'search_guides']);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, undefined, `${name}: ${response.content?.[0]?.text}`);
    return JSON.parse(response.content[0].text);
  };
  // Search first to exercise a cold build when the server cache is empty.
  const firstStart = performance.now();
  const first = await call('search_guides', { query: 'voice scams' });
  const firstSearchMs = performance.now() - firstStart;
  assert.ok(first.results.length > 0);
  assert.equal(first.note, null, 'cold first search must cover the full public index');
  assert.equal(first.operations.budget, 900);
  assert.ok(first.operations.used <= 900);
  const secondStart = performance.now();
  const second = await call('search_guides', { query: 'voice scams' });
  const secondSearchMs = performance.now() - secondStart;
  assert.ok(second.results.length > 0);
  assert.equal(second.note, null);
  assert.match(second.results[0].title, /voice scams/i);
  const hits = second.results;
  const guides = await call('list_guides', {});
  assert.ok(guides.length > 20);
  const guide = await call('get_guide', { id_or_title: hits[0].id });
  const byTitle = await call('get_guide', { id_or_title: hits[0].title });
  assert.match(guide.text, /voice/i);
  assert.equal(guide.read_url, hits[0].read_url);
  assert.equal(byTitle.id, guide.id);
  console.log(JSON.stringify({
    endpoint: url.href,
    tools: tools.tools.map(({ name }) => name),
    guide_count: guides.length,
    first_search_note: first.note,
    second_search_note: second.note,
    first_search_operations: first.operations,
    second_search_operations: second.operations,
    first_search_wall_ms: Number(firstSearchMs.toFixed(1)),
    second_search_wall_ms: Number(secondSearchMs.toFixed(1)),
    top_search_title: hits[0].title,
    full_text_characters: guide.text.length,
    public_link: guide.read_url
  }, null, 2));
} finally {
  await client.close();
}
