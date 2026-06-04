# operational-rules

Code + operational invariants that apply across the codebase. Migrated from agent memory's `feedback_*` entries that aren't customer-messaging-voice (those live in [[customer-voice]]).

## Database join discipline

- **Internal joins use the UUID.** Every `shopify_*_id`, `appstle_*_id`, etc. is a boundary field — only for crossing into the external API, never for joining between our tables. Shopify is being sunset; every `shopify_contract_id`, `shopify_customer_id`, `shopify_order_id` will be deprecated.
- A column-nullable UUID FK that's always populated in practice is a **data invariant**, not a fallback signal. Treat NULL as a bug to surface, not a reason to fall back to `shopify_*_id`.
- **Customer URLs in the dashboard use the internal UUID**, never the Shopify ID. Anyone holding a saved link to a customer page needs that link to survive the Shopify cutover.

See also: [[README]] § Naming conventions for the table-level version of this rule.

## Status enum case

- **All status / enum-like text columns are lowercase.** `subscriptions.status='active'`, `dunning_cycles.status='retrying'`, etc. Writing `.eq("status", "ACTIVE")` returns zero rows silently.
- When in doubt, probe a sample before filtering. See [[README]] § Probing technique.

## Customer-identity rules

- **`shopify_customer_id` is the primary external lookup** for matching a customer to a Shopify-side payload. Match by Shopify ID first; email is a fallback because emails change.
- **No authorized resellers.** Anyone selling our products on Amazon / eBay / wholesale platforms is unauthorized. New rows in `known_resellers` default to `status='active'` (the fraud-detection rule activates immediately). See [[lifecycles/fraud-detection]].

## Order address fallback

When a Shopify order arrives with only one address populated:

1. If `shipping_address` is set + `billing_address` is null → mirror shipping into billing.
2. If billing is set + shipping is null → mirror billing into shipping.
3. If both are null → fall back to `Customer.defaultAddress` via the `orders/address-fallback` Inngest job.

Critical for the `amazon_reseller` fraud rule which compares ship vs bill — never let a one-sided address bypass the check.

## Orchestrator discipline

- **The orchestrator picks IDs only.** Hardcoded code paths fetch the data, validate, and execute. Don't ask the AI to build configs or full payloads — that's where hallucinations land. The orchestrator returns `{action_type, handler_name, ids}`; the executor reads from the DB and does the work.
- **Confirmed-fraud gate runs BEFORE the orchestrator.** If any of the customer's profiles (or any linked profile) has `fraud_cases.status='confirmed_fraud'` OR an `amazon_reseller` flag OR the order address matches a known reseller, the orchestrator short-circuits: escalate to an agent, don't close. Never close-without-action on a flagged customer.
- **AI uses workflows for actions, not autonomous mutations.** The action_executor dispatch table is the allowlist. Anything outside that table requires an agent.

## Returns

- **Customer pays return shipping** unless a crisis-return / goodwill exception applies. AI / playbooks must not promise prepaid labels.
- **Customer must provide tracking** when shipping their return back. We don't issue refunds based on "I sent it" with no proof.
- **No supervisor promises.** AI doesn't offer "let me have a supervisor call you" — that's a path we can't fulfill.
- **Return refunds fire on the EasyPost `delivered` webhook**, never on the initial carrier scan. Initial scans are noisy and routinely reverse.
- **Crisis returns are fully automated** by the Sonnet orchestrator; don't escalate them unless a hard error blocks the pipeline.

## Inngest + Vercel patterns

- **Don't fire-and-forget in Vercel serverless.** A pending HTTP response gets the function killed mid-flight when Vercel reaps it. Either `await` the work inline, or fire an Inngest event and let the durable runtime handle it.
- **Don't push to Vercel during active Inngest syncs** — Vercel's deploy reaps in-flight functions. Wait for syncs to drain.
- **Dylan reviews on the live deployment, not localhost.** When he "can't see" a change, it's almost always undeployed — not missing code. To show a change, commit + push to `main` (Vercel auto-deploys production); don't spin up a local dev server to demo. Scope each commit to its own feature; leave his unrelated in-progress edits uncommitted.

## Shopify extension deploy

After editing files under `shopify-extension/portal-src/`:

1. Run `node scripts/build-all-portals.js` — builds both the Shopify extension portal AND the mini-site portal from the same source.
2. Run `shopify app deploy` for the extension itself.

Skip either step and the customer-facing portal will be out of sync with what's in source.

## Gorgias

- **Keep Gorgias code out of production.** The migration is complete; Gorgias is read-only / archive-only. Any Gorgias API calls live in standalone `scripts/` files for historical lookups, never in `src/`.

## Reusable components

- **Cross-page UI elements must use shared components.** When something appears in two places (subscription card, customer chip, ticket status badge), it's a shared component in `src/components/`. Never duplicate inline in multiple page files — the two copies will drift.

## Anomaly framing

- **Tickets ARE anomaly reports.** The system was supposed to do X, the customer thinks Y happened — that's the gap the AI / agent investigates. Data tools should surface contradictions, not raw state dumps. The orchestrator decision should be framed as "what's the gap and what closes it," not "answer this question."
- **Anomaly framing is neutral.** Never assign blame to "us" or "the customer" until verified. State the facts side-by-side and let the resolution emerge from the data.

## Related

[[customer-voice]] · [[ui-conventions]] · [[lifecycles/ai-multi-turn]] · [[lifecycles/fraud-detection]] · [[lifecycles/return-pipeline]] · [[README]]
