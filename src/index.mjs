import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { getGuide, listGuides, searchGuides } from './guides.mjs';

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Use Havens Commons with your AI</title>
<style>body{font:18px/1.55 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.25rem;color:#173029;background:#f8f9f5}h1,h2{line-height:1.2}h1{font-size:2.3rem}h2{margin-top:2.5rem}a{color:#155a49}code{overflow-wrap:anywhere;background:#e9eee7;padding:.15rem .35rem}li{margin:.5rem 0}.note{border-left:4px solid #71947e;padding-left:1rem}footer{margin:3rem 0;color:#4c6255;font-size:.9rem}</style>
</head><body><main><h1>Use Havens Commons with your AI</h1>
<p>Add this read-only address to your AI, then ask it to find and read a Commons guide:</p>
<p><code>https://commons.travishavens.com/mcp</code></p>
<h2>Claude</h2><ol><li>Open Customize, then Connectors.</li><li>Select Add, then Add custom connector. Name it Havens Commons and paste the address above.</li><li>Under Authentication, choose No sign in, then select Add. Then ask Claude to find a Commons guide.</li></ol>
<p>Claude Free allows one custom connector. On Team and Enterprise, an owner adds it under Organization settings, Connectors, and members then select Connect.</p>
<h2>ChatGPT</h2><ol><li>On ChatGPT web, open Plugins and choose Add custom MCP server if your plan offers it.</li><li>Paste the address above and review the read-only tools.</li><li>Create it as a plugin, then select it in a chat.</li></ol>
<p>OpenAI currently documents custom MCP connections for Pro (read-only tools, which is all this server has) and for Business and Enterprise/Edu workspaces, subject to workspace permissions. Free and Plus are not listed.</p>
<p class="note">Privacy: your tool request passes through this server. It does not log tool arguments. It reads only the public Commons Google Docs and keeps a copy of each guide for about one hour.</p>
<p><a href="https://sites.google.com/view/havens-commons">Browse the Havens Commons website</a></p>
</main><footer>Kept by Claude for the Havens Commons</footer></body></html>`;

const readOnly = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const failure = (error) => ({ isError: true, content: [{ type: 'text', text: error.message }] });
const MAX_BODY_BYTES = 64 * 1024;

function createServer(cache, operationsBudget) {
  const server = new McpServer({ name: 'havens-commons', version: '0.1.0' });
  server.registerTool('list_guides', {
    description: 'List every current Havens Commons guide with its section and public reading and plain-text links.',
    annotations: readOnly
  }, async () => {
    try { return result(await listGuides(cache)); } catch (error) { return failure(error); }
  });
  server.registerTool('search_guides', {
    description: 'Search guide titles and full text for a topic. Returns matching guides and a retry note while the index warms.',
    inputSchema: { query: z.string().min(1).max(150).describe('Words to find in the Commons guides') },
    annotations: readOnly
  }, async ({ query }) => {
    try {
      return result(await searchGuides(query, cache, operationsBudget));
    } catch (error) { return failure(error); }
  });
  server.registerTool('get_guide', {
    description: 'Read the full current text of one Commons guide by its ID or title, with a public link for citation.',
    inputSchema: { id_or_title: z.string().min(1).max(200).describe('Guide ID or title from list_guides or search_guides') },
    annotations: readOnly
  }, async ({ id_or_title }) => {
    try {
      return result(await getGuide(id_or_title, cache));
    } catch (error) { return failure(error); }
  });
  return server;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return new Response('Request body too large', { status: 413 });
    const chunks = [];
    if (request.body) {
      const reader = request.body.getReader();
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return new Response('Request body too large', { status: 413 });
        }
        chunks.push(value);
      }
    }
    const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const limit = await env.COMMONS_RATE_LIMITER.limit({ key });
    if (!limit.success) return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } });
    const rpcError = (code, message) => Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status: 400 });
    let parsedBody;
    try {
      parsedBody = JSON.parse(await new Blob(chunks).text());
    } catch {
      return rpcError(-32700, 'Parse error: Invalid JSON');
    }
    // Each message in a batch would get its own operation budget, so one request could pass Cloudflare's per-request caps.
    if (Array.isArray(parsedBody)) return rpcError(-32600, 'Batch requests are not supported; send one JSON-RPC message per request');
    const server = createServer(globalThis.caches?.default, env.OPERATIONS_BUDGET);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody });
  }
};
