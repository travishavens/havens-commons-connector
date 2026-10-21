import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.mjs';

const endpoint = 'https://commons.travishavens.com/mcp';

test('MCP only accepts POST', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await worker.fetch(new Request(endpoint, { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
  }
});

test('root page names the current OpenAI custom MCP plans', async () => {
  const response = await worker.fetch(new Request('https://commons.travishavens.com/'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /custom MCP connections for Pro \(read-only tools, which is all this server has\) and for Business and Enterprise\/Edu workspaces, subject to workspace permissions\. Free and Plus are not listed\./);
});

test('root page gives the Claude custom connector steps', async () => {
  const response = await worker.fetch(new Request('https://commons.travishavens.com/'));
  const text = await response.text();
  assert.match(text, /Select Add, then Add custom connector\. Name it Havens Commons and paste the address above\./);
  assert.match(text, /Under Authentication, choose No sign in, then select Add\./);
  assert.match(text, /Claude Free allows one custom connector\. On Team and Enterprise, an owner adds it under Organization settings, Connectors, and members then select Connect\./);
});

test('root page answers HEAD without a body', async () => {
  const response = await worker.fetch(new Request('https://commons.travishavens.com/', { method: 'HEAD' }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('MCP rejects JSON-RPC batch bodies with 400', async () => {
  const env = { COMMONS_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const batch = [1, 2].map((id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_guides', arguments: { query: 'voice' } } }));
  const response = await worker.fetch(new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(batch)
  }), env);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, -32600);
});

test('MCP rejects bodies over 64 KB with or without a size header', async () => {
  const declared = await worker.fetch(new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Length': '65537' },
    body: '{}'
  }));
  assert.equal(declared.status, 413);
  const streamed = await worker.fetch(new Request(endpoint, {
    method: 'POST',
    body: 'x'.repeat(65537)
  }));
  assert.equal(streamed.status, 413);
});
