# libraries/commerce__subscription

The **Display** half of the commerce SDK for subscriptions — one read/list surface, internal-vs-Appstle-aware via [[commerce__price]] `priceSubscription`, backing onto a Postgres RPC so a workspace with >1000 subs is walked without silent truncation.

**File:** `src/lib/commerce/subscription.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 1 · **Depends on:** [[commerce__price]] · [[../tables/subscriptions]] · [[../tables/orders]]

## Why this exists

The M2 goal ([[../specs/spec-goal-branch-pm-flow]] · Centralized Commerce SDK) collapses every surface's per-page subscription hydration onto one contract. Two invariants matter for the Display layer:

- **No money render says `$NaN` / `$0` / `undefined`.** Every op runs the sub through [[commerce__price]] `priceSubscription`, so `SubscriptionView.pricing` is populated on internal (engine-priced) AND Appstle-baked branches with a `PriceInvariantError` on any drift.
- **No silent truncation.** Ad-hoc `.from('subscriptions').select(...)` is capped at 1000 rows by PostgREST. The list ops cursor-paginate on `(updated_at DESC, id DESC)` via the `commerce_list_subscriptions` RPC (see [[../tables/subscriptions]] and `supabase/migrations/20260914120000_commerce_list_subscriptions_rpc.sql`), so a workspace with >1000 subs is walked to completion.

Ships with zero call-site consumers — the M3 harness compares SDK output to the current portal / dashboard / AI hydration paths before any surface migrates.

## Exports

- **`getSubscription(workspaceId, subId)`** → `SubscriptionView` — one sub fetched by internal UUID, priced for display, latest renewal joined in a follow-up round trip. Throws when the sub is missing or not in the given workspace.
- **`listSubscriptionsByCustomer(workspaceId, customerId)`** → `SubscriptionView[]` — every sub for one customer (direct `customer_id` match — link-follow is a caller concern), priced and paginated the same way as `listSubscriptions`.
- **`listSubscriptions(workspaceId, filters?)`** → `SubscriptionView[]` — a workspace's subs with optional `SubscriptionListFilters` (`status`, `last_payment_status`, `is_internal`, `comp`, `customer_id`, `page_size`, `max_rows`). Backs onto the `commerce_list_subscriptions` RPC — each page projects sub + latest_order + upcoming_order in one round trip; the SDK walks the cursor until fewer rows than `page_size` come back or `max_rows` caps it. Default `page_size = 500`, default `max_rows = ∞`.

Type re-exports: `SubscriptionView`, `SubscriptionLineView`, `SubscriptionPricingView`, `SubscriptionListFilters`.

The RPC's returned upcoming_order carries just `next_billing_date`; the SDK fills in `projected_total_cents` from `priceSubscription`'s rollup on the same view.

## SubscriptionView latest_order + upcoming_order

Compact projections joined by the list RPC so a caller can render a subscription card without a second query:

- `latest_order` — `{ id, order_number, financial_status, delivery_status, total_cents, created_at, delivered_at }` from the most recent [[../tables/orders]] row keyed on `subscription_id`. `null` when the sub has never billed. Full `OrderView` arrives via [[commerce__order]].
- `upcoming_order` — `{ next_billing_date, projected_total_cents }` where `projected_total_cents` comes from `priceSubscription`'s own rollup on the same view. `null` when the sub carries no `next_billing_date`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

## Verification

The Phase 1 verification probe is `scripts/_probe-commerce-display-subs.ts`. Two checks:

- **Walk past 1000.** Picks the largest workspace by `subscriptions.workspace_id` bucket (or a `--workspace=<uuid>` override), runs `listSubscriptions`, asserts the returned count exceeds 1000 when the DB count does.
- **Appstle canary pricing to the cent.** Optional (opt-in via `--canary-sub=<uuid>`). Reads the sub row + runs `getSubscription`, asserts `SubscriptionView.pricing.total_cents` matches `priceSubscription`'s own rollup to the cent — locks in the invariant that the SDK's view doesn't drift from the money resolver.

Install the RPC first: `npx tsx scripts/apply-commerce-list-subscriptions-rpc-migration.ts`.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__price]]
