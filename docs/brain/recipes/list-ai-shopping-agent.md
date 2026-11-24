# Recipe — list the AI shopping agent in the Claude + ChatGPT directories

How to submit (and re-submit) the ShopCX AI shopping-agent MCP server to the AI-assistant directories. The server itself is [[../libraries/shopping-agent]] at `/api/mcp/[workspace]`; connection facts live in [[../integrations/ai-assistant-mcp]]; the end-to-end trace is [[../lifecycles/ai-shopping-agent]].

**Public URL:** `https://{storefront_domain}/api/mcp/{workspace_slug}` (Streamable HTTP, POST JSON-RPC).

## Pre-flight (all directories)

- [ ] `search_products` / `find_products_for_situation` return real cards (seed [[../tables/product_customer_situations]] first — run `scripts/_backfill-customer-situations.ts`).
- [ ] Every tool declares `annotations.readOnlyHint` (`build_cart` is `readOnlyHint:false, destructiveHint:false`).
- [ ] The FDA disclaimer rides every product payload; the compliance block list is live.
- [ ] The kill switch `ai:shopping-agent-mcp` is ON (not disabled).
- [ ] 3–5 screenshots of the agent in use, ≥1000px.

## Claude (self-serve)

Claude lists self-serve — no human review gate.

1. Go to **https://claude.ai/directory/manage** (the Claude connectors / directory management portal) and add a custom connector by URL.
2. Enter the public MCP URL above. Claude calls `initialize` + `tools/list` and reads the tool `annotations` (readOnlyHint drives the "read-only" badge).
3. Declare the allowed external link origin = the storefront checkout origin (so `build_cart` checkout links open).
4. Upload the 3–5 PNG screenshots (≥1000px).
5. Submit. Claude self-publishes; verify the connector appears and the tools list.

## ChatGPT (OpenAI Apps — reviewed)

OpenAI reviews submissions and requires org verification + domain verification + test cases.

1. **Org verification:** an org owner verifies the organization on the OpenAI Platform (platform.openai.com).
2. **Domain verification:** set `workspaces.openai_apps_challenge_token` (the token OpenAI gives you) and confirm it serves at `https://{storefront_domain}/.well-known/openai-apps-challenge` (route: `src/app/.well-known/openai-apps-challenge/route.ts`).
3. **Privacy policy:** point OpenAI at `/privacy` § 8 (AI Shopping Assistant) — specific, not boilerplate (OpenAI rejects generic text).
4. **Support contact + docs:** the `/shopping-assistant` page (what it does, example prompts, `support@shopcx.ai`).
5. **Test cases:** provide example prompts (see `/shopping-assistant`) that exercise `search_products`, `find_products_for_situation`, `get_product_details`, `build_cart`.
6. Upload screenshots, submit for review, and address any reviewer feedback.

## Grok

Grok has no public listing path yet — it connects as a **custom connector by URL** (same public MCP URL). Contact xAI for catalog inclusion. Grok receives the same tool data as text (no MCP Apps UI cards).

## Re-submitting

After a tool/annotation/compliance change, bump `serverInfo.version` in `src/app/api/mcp/[workspace]/route.ts`, re-run the pre-flight, and re-submit via the same portals. Claude re-reads `tools/list` live; ChatGPT may re-review.
