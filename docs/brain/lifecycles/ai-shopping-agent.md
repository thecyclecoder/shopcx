# AI shopping-agent lifecycle

End-to-end trace of the Superfoods AI shopping agent: one public MCP server inside ShopCX that ChatGPT, Claude and Grok connect to, recommending products by the shopper's situation, answering from real product intelligence under hard compliance guardrails, and handing a built cart off to our own Braintree checkout. The CEO approved building our own agent on 2026-11-23 instead of enabling Shopify's thin-catalog ChatGPT agent.

## The flow

```
AI app (ChatGPT / Claude / Grok)
  │  POST JSON-RPC  →  https://{storefront_domain}/api/mcp/{workspace_slug}
  ▼
src/app/api/mcp/[workspace]/route.ts   (stateless Streamable HTTP)
  │  resolve workspace (getWorkspaceBySlug) · rate-limit per IP · label platform
  │  kill-switch gate (resolveEffectiveSwitch "ai:shopping-agent-mcp")
  ▼
tools/call → src/lib/shopping-agent/tools.ts
  │  read product intelligence / situations / RAG / policies (all read-only)
  │  EVERY returned string → compliance.ts (drop blocked quotes/sentences, count)
  │  build_cart → cart.ts priceCartLines → cart_drafts → UTM-tagged checkout URL
  ▼
log → shopping_agent_calls (redacted args, result ids, blocked count, latency)
heartbeat → emitInlineAgentHeartbeat("ai:shopping-agent-mcp")  (try/finally)
  ▼
shopper taps checkout link → our own storefront checkout (Braintree/Avalara/OTP/CAPI unchanged)
  │  utm_source=<platform>, utm_medium=ai_agent captured on the storefront session
  ▼
storefront funnel (/api/workspaces/[id]/storefront-funnel) → aiChannelBreakdown by AI app
```

## Phases (build order)

- **Phase 1 — situations dataset.** [[../tables/product_customer_situations]] + [[../libraries/customer-situations]] SDK (compliant-only reads) + idempotent seed from the Tabs fixture. Shared with PDP AEO.
- **Phase 2 — read-only MCP server.** [[../libraries/shopping-agent]] route + 6 read-only tools (`readOnlyHint`), the [[../libraries/shopping-agent|compliance module]] (hard FDA/FTC block lists + safety gate + disclaimer), [[../tables/shopping_agent_calls]] log, and the owned/switchable/heartbeating node ([[control-tower-node-registry]] `ai:shopping-agent-mcp` → cmo).
- **Phase 3 — cards + cart handoff.** Shared `priceCartLines` (route + tool, no duplicated pricing), `build_cart` with per-AI-app UTM, MCP Apps `ui://` cards (`text/html;profile=mcp-app`), and AI-channel attribution in the storefront funnel.
- **Phase 4 — directory readiness.** `/privacy` § 8 + `/shopping-assistant` support page, the `/.well-known/openai-apps-challenge` domain-verification route, and the [[../recipes/list-ai-shopping-agent]] recipe.

## Compliance invariant

Nothing existing covered health claims (`safeCore` is image geometry; `claim-guard` is CS effect-claims), so the agent has its OWN module. Every string a tool returns is screened before it leaves; the mandatory FDA disclaimer rides every product payload; a safety-sensitive shopper input returns a doctor note + contraindications and no recommendation. No raw shopper health text is persisted.

## Status / open work

**Shipped:**
- Phase 1 — situations table + SDK + seed backfill.
- Phase 2 — MCP server, 6 read-only tools, compliance module (+ unit test `test:shopping-agent-compliance`), calls log, control-tower node.
- Phase 3 — shared pricing, `build_cart`, MCP Apps cards, funnel `aiChannelBreakdown`.
- Phase 4 — privacy section, support page, domain-verification route, listing recipe.

**Open work / not yet done:**
- **Submit the listings:** Claude self-serve (claude.ai/directory/manage) and ChatGPT after OpenAI org + domain verification — human steps, see [[../recipes/list-ai-shopping-agent]]. Grok custom-connector-by-URL (contact xAI).
- Rate limiting is in-memory per instance (best-effort); a shared store would tighten it across instances.
- `find_products_for_situation` matching is keyword-overlap; embedding similarity is a future upgrade.

## Related

[[../libraries/shopping-agent]] · [[../libraries/customer-situations]] · [[../tables/product_customer_situations]] · [[../tables/shopping_agent_calls]] · [[../integrations/ai-assistant-mcp]] · [[../recipes/list-ai-shopping-agent]] · [[storefront-checkout]] · [[product-intelligence]]
