# AI assistant MCP (ChatGPT / Claude / Grok)

The external-facing side of the AI shopping agent: how ChatGPT, Claude and Grok connect to the ONE ShopCX MCP server and what each platform supports. The server implementation is [[../libraries/shopping-agent]]; the listing procedure is [[../recipes/list-ai-shopping-agent]].

## Endpoint

- **URL:** `https://{storefront_domain}/api/mcp/{workspace_slug}` (falls back to `https://shopcx.ai/store/{slug}/...` resolution of the workspace segment, same as the storefront).
- **Transport:** MCP Streamable HTTP — stateless JSON-RPC over `POST`. `GET` → 405.
- **Auth:** none (public, read-only tools). `build_cart` writes a `cart_drafts` row but exposes no customer data.
- **Methods:** `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`.
- **Protocol version advertised:** `2025-06-18`. `serverInfo`: `{ name: "shopcx-shopping-agent", version }`.
- **Rate limiting:** per-IP, 60 requests/min (in-memory, best-effort).

## Platform support matrix

| Capability | ChatGPT | Claude | Grok |
|---|---|---|---|
| Connect to a remote MCP server by URL | ✅ | ✅ | ✅ (custom connector) |
| Tool `annotations.readOnlyHint` | ✅ | ✅ (drives the read-only badge) | ✅ |
| MCP Apps UI cards (`ui://`, `text/html;profile=mcp-app`) | ✅ (also via `openai/outputTemplate` alias) | ✅ | ❌ (receives data as text) |
| Directory listing | reviewed (org + domain verification, test cases) | self-serve (claude.ai/directory/manage) | no public listing yet |

## Platform identity

The server labels each call's platform from `initialize.clientInfo.name` (or the User-Agent) → `chatgpt` / `claude` / `grok` / `other`, stored on [[../tables/shopping_agent_calls]] and used to tag `build_cart` checkout URLs (`utm_source=<platform>`, `utm_medium=ai_agent`) so the storefront funnel splits AI-channel traffic.

## MCP Apps cards

Tools link a UI resource via `_meta."ui.resourceUri"` + the `openai/outputTemplate` alias. Resources are served by `resources/read` with MIME `text/html;profile=mcp-app`. The allowed external link origin to declare at listing time is the storefront checkout origin.

## Domain verification (ChatGPT)

OpenAI verifies the storefront domain via `/.well-known/openai-apps-challenge` (route `src/app/.well-known/openai-apps-challenge/route.ts`), which serves `workspaces.openai_apps_challenge_token` as text/plain.

## Related

[[../libraries/shopping-agent]] · [[../tables/shopping_agent_calls]] · [[../tables/product_customer_situations]] · [[../recipes/list-ai-shopping-agent]] · [[../lifecycles/ai-shopping-agent]]
