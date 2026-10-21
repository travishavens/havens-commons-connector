# Havens Commons connector

This read-only [MCP](https://modelcontextprotocol.io/) server lets an AI app list, search, and read the public [Havens Commons guides](https://sites.google.com/view/havens-commons). It runs as a Cloudflare Worker at `https://commons.travishavens.com/mcp`. The tools are `list_guides`, `search_guides`, and `get_guide`.

The public [Start here guide](https://docs.google.com/document/d/1DCs802oe4EegUbVrst5DRX7nXBHm3-hz0QroePziaCE/edit) is the catalog. The Worker reads its public HTML export and follows the public Google Docs links listed there. It keeps the index and guide text in Cloudflare's cache for about one hour. New guides become searchable after the index cache expires.

## Add it to your AI app

Add this read-only address to your AI, then ask it to find and read a Commons guide:

```text
https://commons.travishavens.com/mcp
```

**Claude:** Open Customize, then Connectors. Select Add, then Add custom connector. Name it Havens Commons and paste the address above. Under Authentication, choose No sign in, then select Add. Then ask Claude to find a Commons guide. Claude Free allows one custom connector. On Team and Enterprise, an owner adds it under Organization settings, Connectors, and members then select Connect.

**ChatGPT:** On ChatGPT web, open Plugins and choose Add custom MCP server if your plan offers it. Paste the address above and review the read-only tools. Create it as a plugin, then select it in a chat. OpenAI currently documents custom MCP connections for Pro (read-only tools, which is all this server has) and for Business and Enterprise/Edu workspaces, subject to workspace permissions. Free and Plus are not listed.

## Use it for your own public Docs

Fork this repository and use your own public Google Docs collection:

1. Make an index Google Doc public. Format each section title as Heading 3 and begin it with two digits, such as `01 Getting started`; the parser reads only `<h3>` headings in the HTML export and skips every other heading level. For each guide, include a browser link to its `/edit` URL and a matching plain-text `/export?format=txt` link labeled `for your AI`. The parser uses those pairs to identify the guides it may read.
2. Set `START_ID` in `src/guides.mjs` to your index Doc ID. Set `CACHE_ROOT` there to `https://your-domain.example/_cache` so your cache keys belong to your domain.
3. Set the custom domain under `routes` in `wrangler.jsonc`. Update the address and site link on the root page in `src/index.mjs` to match your collection.
4. Install Node.js 22 or later (Wrangler 4 requires it), then run `npm ci`, `npm test`, and `npm run deploy:dry`. Sign in to your own Cloudflare account with `npx wrangler login`, then run `npm run deploy`. Point your AI app at `https://your-domain.example/mcp`.

`wrangler.jsonc` has no account ID, so Wrangler uses the signed-in account. On Workers Free, set `OPERATIONS_BUDGET` in `wrangler.jsonc` to `46` or delete that var. Keep the rate limit binding or adjust it for your deployment. Only Docs that are publicly readable through Google's HTML export can be used. The Worker does not use Google credentials, follow export redirects, or change Docs.

## Operation budget

The `OPERATIONS_BUDGET` Wrangler var controls how many combined `fetch()` and Cache API operations one search may use. This repository sets it to `900` for Workers Paid. A cold search can build the full corpus in one request for the current 38 guides and for a 140-guide collection. The var accepts a whole number from `46` to `900`; if it is missing, invalid, or outside that range, the code uses `46`, which leaves room under Workers Free's 50-operation request limit. A Free-plan cold search may return a warming note; search again to cover the remaining guides. The Free-plan guide cap is 140. The cap rises with the configured budget, up to 425 guides at 900 operations.

Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) list 50 subrequests and 10 ms CPU per request on Free, and 10,000 subrequests and 30 seconds CPU per request by default on Paid. Cache API calls share the subrequest quota and have their own cap of 50 per request on Free and 1,000 on Paid, which is why the budget stops at 900. The local tests check operation counts, but they do not prove production CPU time, wall-clock time, or availability of Google's exports. A cold search fetches guides one at a time, so its wall time grows with the collection; 38 guides took 8 to 17 seconds from a laptop.

## Privacy

The Worker does not log tool arguments. It reads public Docs only, caches their text for about one hour, and exposes read-only tools. Your AI provider and Cloudflare may process requests under their own policies.

## Test locally

```sh
npm ci
npm test
npm run dev
```

With the local Worker running, use another terminal for `node scripts/local-check.mjs`. This check reads the live public Docs and requires the first search to return full results. It is written for the Havens Commons collection (a budget of `900`, more than 20 guides, and a guide about voice scams), so a fork should adjust those expectations. `npm run deploy:dry` checks the deployment bundle without publishing it.

## License

MIT. See [LICENSE](LICENSE).
