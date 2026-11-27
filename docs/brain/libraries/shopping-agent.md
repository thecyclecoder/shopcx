# `src/lib/shopping-agent/` — AI shopping-agent MCP server

The public, read-only MCP server that ChatGPT, Claude and Grok connect to. It recommends Superfoods products by the shopper's situation and answers from real product intelligence under hard, in-code compliance guardrails, then hands a built cart off to our own Braintree storefront checkout. Route: `src/app/api/mcp/[workspace]/route.ts`. Node: `ai:shopping-agent-mcp` → owner `cmo`.

Built across Phases 2–3 of the AI-shopping-agent build (Phase 1 = [[customer-situations]] + [[../tables/product_customer_situations]]). Connection facts: [[../integrations/ai-assistant-mcp]]. End-to-end: [[../lifecycles/ai-shopping-agent]].

## Files

| File | What |
|---|---|
| `src/app/api/mcp/[workspace]/route.ts` | The transport. Stateless JSON-RPC over POST (`initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`; GET → 405). Resolves `[workspace]` via `getWorkspaceBySlug`. Per-IP rate limit (60/min). Labels the platform from `initialize.clientInfo` / User-Agent. Kill-switch gate + `emitInlineAgentHeartbeat` per request + `logShoppingAgentCall` per tool call. |
| `tools.ts` | The 7 tools + handlers. Six read-only (`readOnlyHint:true`) + `build_cart` (`readOnlyHint:false, destructiveHint:false`). Every returned string passes through compliance before leaving. |
| `compliance.ts` | The hard FDA/FTC structure/function guardrail (self-contained — NOT `safeCore`/`claim-guard`). `checkClaim` / `filterText` / `filterQuotes` / `evaluateSafetyGate` + `MANDATORY_DISCLAIMER`. Unit-tested (`test:shopping-agent-compliance`). |
| `cart.ts` | Shared pricing chokepoint. `priceCartLines` (the pricing both the storefront cart route AND `build_cart` call — no duplicated pricing), `buildCartForAgent`, `buildAgentCheckoutUrl`, `listFlavors`, `AI_AGENT_MEDIUM`. |
| `resources.ts` | MCP Apps UI resources (`ui://`, MIME `text/html;profile=mcp-app`): a product card + a pack picker. |
| `calls.ts` | `shopping_agent_calls` write SDK — `logShoppingAgentCall` (best-effort), `platformFromClientName`. See [[../tables/shopping_agent_calls]]. |

## Tools

| Tool | readOnlyHint | What |
|---|---|---|
| `search_products` | true | Active products: title, image, rating + review count, lead benefit, price/serving. |
| `find_products_for_situation` | true | Matches the shopper's situation against [[../tables/product_customer_situations]] (via [[customer-situations]], compliant-only); returns product + what customers noticed + 1–2 compliant quotes (first name + initial). Input-side safety gate. |
| `get_product_details` | true | Ingredients + doses, supplement facts quoted ONLY from `product_variants.supplement_facts` (never PDP copy), how-to-use, expectation timeline, guarantee, contraindications from `product_ingredient_research`. Caffeine always stated. |
| `answer_product_question` | true | RAG over `retrieveContext` (kb_chunks) + published `product_page_content.faq_items` + ingredient research; policy questions via `getPolicyCustomerFacing` (never internal_summary/rules). |
| `get_reviews` | true | Best-reviews set (published/featured, rating ≥ 4, featured first), optional topic filter. |
| `compare_products` | true | 2–4 products side by side. |
| `build_cart` | false | Prices a product + pack tier (+ optional `flavor`, matched case-insensitively to a variant title/option via `variantByFlavor`, else the primary variant; the result lists `available_flavors`) via `priceCartLines`, writes a `cart_drafts` row, returns a UTM-tagged checkout URL (`utm_source=<chatgpt\|claude\|grok>`, `utm_medium=ai_agent`). |

## Compliance (hard, in code)

Applied to EVERY string a tool returns before it leaves the server. A blocked **quote** is dropped whole (never rewritten); a blocked generated **sentence** is dropped and counted (the count feeds [[../tables/shopping_agent_calls]]). Rules (word-boundary, case-insensitive): disease/condition terms, drug comparisons (GLP-1/Ozempic/semaglutide/…), weight-loss quantification + guarantee/hype phrases. Allowed: structure/function + customer-attributed experience framing. Mandatory disclaimer on every product payload (exempt from the block list). Input-side safety gate on pregnancy/nursing/medication/under-18/medical condition/disease term → doctor note + contraindications, no recommendation/quote. No raw shopper health text is ever persisted.

## Supervision (north-star trio)

- **Owned:** `ai:shopping-agent-mcp` → `cmo` in [[control-tower-node-registry]] (INLINE_AGENT_IDS + a MONITORED_LOOPS inline-agent row).
- **Switchable:** the route reads `resolveEffectiveSwitch("ai:shopping-agent-mcp")`; off ⇒ a polite "temporarily unavailable" tool error (route stays up). Ancestry: `ai:shopping-agent-mcp` → `director:cmo` → `dept:cmo`.
- **Heartbeat:** `emitInlineAgentHeartbeat` at the end of every request (try/finally; ok:false on throw). Error-rate liveness only (external callers, no backlog signal).

## Related

[[customer-situations]] · [[../tables/product_customer_situations]] · [[../tables/shopping_agent_calls]] · [[../integrations/ai-assistant-mcp]] · [[../lifecycles/ai-shopping-agent]] · [[../lifecycles/storefront-checkout]] · [[product-intelligence]] · [[policies]] · [[../recipes/list-ai-shopping-agent]]


**Card `_meta` shape (2026-11-27 fix).** Tools with a card declare `_meta.ui.resourceUri` (nested — the MCP Apps spec shape), plus the deprecated flat `ui/resourceUri` alias and ChatGPT's `openai/outputTemplate` (`uiMeta()` in the route). The first ship used a dotted flat key `"ui.resourceUri"` that no host reads, so cards never rendered.
