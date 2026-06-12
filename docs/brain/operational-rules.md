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
- **The Shopify customer sync must never wipe or downgrade storefront-collected data.** A `customers/update` webhook upsert builds the row from the Shopify payload, so a profile that lacks a field would otherwise null it out. We OWN marketing/SMS consent (there is no Shopify UI for a customer to unsubscribe), the verified phone, and names: the sync may only *upgrade* consent to `subscribed` (most-permissive across all local rows for the email) and may only *fill* an empty phone/name — never erase one we hold. See `applyCustomerWebhook` in [[libraries/shopify-webhooks]]. Phones are stored E.164.
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
- **Never issue a direct refund AND a `refund_return` for the same order** — that double-refunds (once now, once when the product comes back). Safety nets: a successful `partial_refund` now stamps any open return on that order as already-refunded (`refund_id` + `refunded_at`), and the issue-refund pipeline skips when those are set. If you're refunding now, the return should only bring the product back; if you want refund-on-receipt, create the `refund_return` and do NOT also `partial_refund`. (Sonia Stevens, SC132396.)
- **Refunds are never self-heal-retried.** A refund is confirmed by its own handler (Braintree refund id / polled Shopify gateway status); its DB verification via `financial_status` is unreliable for Braintree-direct refunds (which never flip it). Re-running would double-refund, so `partial_refund` / `redeem_points_as_refund` are excluded from the self-heal verify+retry loop.
- **No cancel-before-ship. No refund-before-ship.** Once a customer places an order it goes to the 3PL within ~1 hour and is irrevocably in fulfillment. There is no internal mechanism to stop a shipment in flight, void the order, or refund proactively against an unshipped order. The AI must NEVER tell a customer *"I'll cancel the shipment before it leaves"* or *"I'll refund you before it ships"* — both are false promises. The real paths are: (a) wait for delivery → send a return label → refund on the EasyPost `delivered` webhook, (b) issue store credit via the refund playbook (no return required for the goodwill tier), or (c) for crisis-grade cases, fire the crisis return + auto-credit. Pick one of those, set expectations honestly, and route the customer through it.
- **No policy drift on hardship signals.** Hardship/distress/urgency in a customer's message (see [[../customer-voice]] § Hardship/distress) adjusts TONE and SKIPS the stand-firm intermediate rounds. It does NOT change WHAT we offer. The refund-playbook tier ladder is fixed: **tier 1 = `store_credit_return`**, **tier 2 = `refund_return`** (see [[../playbooks/refund]]). Sympathy does NOT unlock a `refund_no_return` outcome, does NOT waive the return-with-tracking requirement, does NOT bypass disqualifiers (previous_exception / has_chargeback / has_chargeback_on_order), and does NOT extend the 30-day MBG window. The AI cannot invent a new tier, lower the return bar, or hand out store credit without running the playbook. If the playbook tier ladder exhausts after tier 2 + the stand-firm-skipped path, escalate via the playbook's normal escalation — there is no "hardship tier 3."

## Inngest + Vercel patterns

- **Don't fire-and-forget in Vercel serverless.** A pending HTTP response gets the function killed mid-flight when Vercel reaps it. Either `await` the work inline, or fire an Inngest event and let the durable runtime handle it.
- **Don't push to Vercel during active Inngest syncs** — Vercel's deploy reaps in-flight functions. Wait for syncs to drain.
- **Dylan reviews on the live deployment, not localhost.** When he "can't see" a change, it's almost always undeployed — not missing code. To show a change, commit + push to `main` (Vercel auto-deploys production); don't spin up a local dev server to demo. Scope each commit to its own feature; leave his unrelated in-progress edits uncommitted.

## RLS on every public table (security invariant)

- **Every table in the `public` schema MUST have RLS enabled**, because Supabase grants `anon` + `authenticated` full table privileges by default — RLS is the only thing gating the public API key. A table created without `ENABLE ROW LEVEL SECURITY` is wide open to the world (read AND write) until RLS is on. Supabase's `rls_disabled_in_public` lint flags these. Standard policy pair (matches the whole schema): `FOR ALL TO service_role USING(true) WITH CHECK(true)` + `FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()))`. Backend-only tables (auth/session state) get the service-role policy only. anon needs no policy — RLS denies it by default. Audit: `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r' AND relrowsecurity=false`. (2026-06-09: 6 tables — auth_otp_sessions, coupons, klaviyo_profile_staging/directory, migration_audits, sms_send_candidates — shipped with RLS off; fixed in `20260609130000_enable_rls_exposed_tables.sql`.)

## Migrations — always apply them

- **When you write a migration, apply it to the database in the same session — don't leave it for "the next deploy."** Dylan's directive (2026-06). Use the `pg` Client pattern in `scripts/apply-*-migration.ts` (tries the pooler/direct connection-string candidates, runs the SQL, verifies the columns/indexes/constraints landed). A migration file that's committed but unapplied means any new code that reads the new columns fails against the live DB until a deploy that may be hours away.

## Shopify extension deploy

After editing files under `shopify-extension/portal-src/`:

1. Run `node scripts/build-all-portals.js` — builds both the Shopify extension portal AND the mini-site portal from the same source. Commit the built bundles (`public/portal-assets/subscription-portal.js` ships with Vercel; the extension theme bundle ships via step 2).
2. From **inside `shopify-extension/`**, run `shopify app deploy --force` (the `--force` skips the interactive release-confirm prompt). The Shopify CLI auth is cached on this machine, so it runs non-interactively. (First-time auth uses a device-code browser flow that a sandboxed shell can't complete — if it ever re-prompts, the user runs the deploy via `!` in their own terminal.)

Skip either step and the customer-facing portal will be out of sync with what's in source. Note: the mini-site bundle (`public/`) only needs the Vercel deploy; only the **theme extension** needs `shopify app deploy`.

## Remotion site deploy

After editing anything under `remotion/` (compositions, `ExampleAd`/`AdStatic`, fonts) **re-run `npx tsx scripts/deploy-remotion-lambda.ts`** to re-upload the bundle to the Lambda site. Production ad renders run on Remotion Lambda (Vercel serverless can't run Remotion) and use the *deployed* site — skip this and Lambda renders a stale composition. See [[integrations/remotion-lambda]]. Local dev (`REMOTION_RENDER_MODE` unset) renders in-process and doesn't need a redeploy.

## Gorgias

- **Keep Gorgias code out of production.** The migration is complete; Gorgias is read-only / archive-only. Any Gorgias API calls live in standalone `scripts/` files for historical lookups, never in `src/`.

## Reusable components

- **Cross-page UI elements must use shared components.** When something appears in two places (subscription card, customer chip, ticket status badge), it's a shared component in `src/components/`. Never duplicate inline in multiple page files — the two copies will drift.

## Anomaly framing

- **Tickets ARE anomaly reports.** The system was supposed to do X, the customer thinks Y happened — that's the gap the AI / agent investigates. Data tools should surface contradictions, not raw state dumps. The orchestrator decision should be framed as "what's the gap and what closes it," not "answer this question."
- **Anomaly framing is neutral.** Never assign blame to "us" or "the customer" until verified. State the facts side-by-side and let the resolution emerge from the data.

## Related

[[customer-voice]] · [[ui-conventions]] · [[lifecycles/ai-multi-turn]] · [[lifecycles/fraud-detection]] · [[lifecycles/return-pipeline]] · [[README]]
