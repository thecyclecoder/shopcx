# Fraud detection

Multi-layer defense system. Combines order-creation rule evaluation, nightly customer-graph scans, Shopify order tagging for fulfillment hold, and confirmed-fraud orchestrator gate. The Reseller Defense System (CLAUDE.md § Reseller Defense) is the most active layer.

## Cast

- Rules: [[../tables/fraud_rules]] (configurable per-workspace).
- Cases: [[../tables/fraud_cases]] (open investigations).
- Audit: [[../tables/fraud_action_log]], [[../tables/fraud_case_history]], [[../tables/fraud_rule_matches]].
- Reseller graph: [[../tables/known_resellers]] + [[../tables/amazon_asins]].
- Brain: `src/lib/fraud-detector.ts` + [[../inngest/fraud-detection]].
- Shopify holds: `src/lib/shopify-order-tags.ts` (`tagsAdd` / `tagsRemove`).
- Geo: `src/lib/geo-distance.ts` (Haversine + zip centroids).
- Orchestrator gate: `src/lib/customer-fraud-status.ts`.

## Rule types

Five active rules in [[../tables/fraud_rules]]:

| slug | What it checks |
|---|---|
| `shared_address` | One shipping address used by N+ distinct customers in M days (account farming). |
| `high_velocity` | Customer creates N+ orders in M minutes (bot / promo abuse). |
| `address_distance` | Billing zip ↔ shipping zip > X miles via Haversine (`zipcodes` package). |
| `name_mismatch` | Billing name ≠ customer name (case-insensitive, configurable last-name-only mode). |
| `amazon_reseller` | Ship+bill address matches [[../tables/known_resellers]] (the active reseller-defense layer). |

Each rule has tunable thresholds + `active` flag in [[../tables/fraud_rules]].`config`.

## Phase 1 — order create

Shopify `orders/create` webhook fires. After persisting the order, the handler calls `evaluateFraudRulesForOrder(orderId)` in `src/lib/fraud-detector.ts`:

1. Load order + customer + link group.
2. Iterate active [[../tables/fraud_rules]] for the workspace.
3. For each, run the matcher (`src/lib/fraud-detector.ts` has one per rule).
4. On any match → create a [[../tables/fraud_cases]] row with `rule_type`, `severity`, `orders_held=true`, `status='open'`.
5. Log the match to [[../tables/fraud_rule_matches]] (per-rule-per-order audit).
6. Log the case creation to [[../tables/fraud_action_log]].

## Phase 2 — amazon_reseller match (two-pass)

The reseller rule is the most aggressive — false positives are costly so it runs in two passes:

### Pass 1 — normalized exact match

Both `Order.shippingAddress` + `Order.billingAddress` get normalized through `src/lib/address-normalize.ts`:

- Lowercase, strip punctuation, collapse whitespace.
- Expand street suffixes (`st` → `street`, `ave` → `avenue`).
- Trim apt / suite / unit identifiers (different units at the same building = same reseller).

The normalized form is compared against [[../tables/known_resellers]].`address_normalized`. Match → flag.

### Pass 2 — Haiku fuzzy

If pass 1 misses but `zip` + street number agree, call Claude Haiku to compare the two address strings. Catches obfuscated variants like "010083 Lynden Ova.l, Apt1" vs the canonical "10083 Lynden Oval Apt 100." Haiku returns `{ match: true|false, confidence: 0..1 }`.

Match (confidence > 0.8) → flag.

## Phase 3 — order hold

When [[../tables/fraud_cases]].`orders_held=true`, we tag every affected order with `suspicious` via [[../integrations/shopify]] `tagsAdd`. Our fulfillment center has a rule: orders tagged `suspicious` are held automatically pending manual review.

- **Dismiss case** → `tagsRemove` releases orders to fulfillment.
- **Confirm fraud** → orders stay tagged, get cancelled or ship-blocked at the warehouse.

Hold logic in `src/lib/shopify-order-tags.ts`.

## Phase 4 — nightly customer-graph scans

[[../inngest/fraud-detection]] also runs nightly checks across the customer graph (not just per-order):

- New shared-address aggregations.
- High-velocity windows that wouldn't trigger on a single order.
- Reseller discovery cross-check: any address that recurs across N+ customers gets reseller-checked.

These produce [[../tables/fraud_cases]] rows the same way per-order checks do.

## Phase 5 — reseller discovery

[[../inngest/reseller-discovery]] runs weekly (Mondays 6 AM CT):

1. For every ASIN we sell ([[../tables/amazon_asins]]), pull competitor offers from Amazon SP-API.
2. Dedupe sellerIds.
3. For each new sellerId, scrape `amazon.com/sp?seller={id}` for business name + address.
4. Upsert to [[../tables/known_resellers]] with `status='active'` (default per feedback_no_resellers_allowed — there are no authorized resellers).
5. Admin review queue surfaces new entries before the fraud rule activates against them (cooling-off window).

One-shot manual run: `npx tsx scripts/discover-resellers.ts`.

## Phase 6 — chargeback intersection

[[chargeback-pipeline]] feeds the fraud system too — chargebacks from suspected fraudsters get classified and can auto-create fraud cases. See chargeback-pipeline for the full flow.

Chargebacks don't always create fraud cases — only when the rule matches a fraud signature. Fraud cases are the actual judgment; chargebacks are the evidence.

## Phase 7 — confirmed_fraud + orchestrator gate

When an admin marks a case `confirmed_fraud` (or our auto-classifier does), three things kick in:

1. **Ban the customer + linked accounts** — flip [[../tables/customers]].`banned=true`, `banned_at`, `banned_reason`.
2. **Cancel all active subs** for the customer + linked accounts via [[../integrations/appstle]] DELETE with `cancellationFeedback="fraud"`.
3. **Orchestrator gate** — every future inbound message goes through `customer-fraud-status.ts`. If ANY case is `confirmed_fraud` OR has `rule_type='amazon_reseller'`, the orchestrator is short-circuited:
   - Send `CONFIRMED_FRAUD_REPLY` ("We're sorry but your account has been flagged for potential fraud.").
   - Tag ticket, close, escalate.
   - No Sonnet, no tools, no actions.

See feedback_orchestrator_fraud_gate.

## Address fallback chain

Order ingestion runs through this chain (per feedback_address_mirror_rule):

1. Use `Order.shippingAddress` and `Order.billingAddress` directly if both present.
2. If only one is populated, **mirror it into both columns**.
3. If both null, fall back to `Customer.defaultAddress` via [[../inngest/order-address-fallback]].

This matters for fraud detection — many rules compare bill vs ship. Without the mirror rule, we'd false-negative on orders where Shopify only populated one address.

## Operational scripts

For one-off ops:

- `scripts/discover-resellers.ts` — one-shot reseller discovery from Amazon SP-API.
- `scripts/reseller-impact-report.ts` — find every order shipped to a known reseller + their active subs.
- `scripts/cancel-and-ban-resellers.ts` — bulk cancel + ban for confirmed resellers (--dry-run / --confirm).
- `scripts/backfill-1yr-addresses.ts` — backfill 365d of orders missing ship/bill addresses.

## Severity levels

[[../tables/fraud_cases]].`severity`:

- `low` — single rule, no smoking gun. Manual review.
- `medium` — multiple rules OR a confirmed reseller match. Hold orders.
- `high` — confirmed fraud signal. Auto-ban + cancel.

## Case lifecycle

`status`: `open` → `reviewing` → `confirmed_fraud` / `dismissed`. [[../tables/fraud_case_history]] tracks transitions.

`reviewing` doesn't release the order hold; only `dismissed` does. `confirmed_fraud` cancels subs + bans customers.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/fraud-detector.ts` | Rule evaluator + case creator |
| `src/lib/customer-fraud-status.ts` | Orchestrator short-circuit check |
| `src/lib/geo-distance.ts` | Haversine + zip centroids |
| `src/lib/known-resellers.ts` | Reseller match logic |
| `src/lib/address-normalize.ts` | Address normalization |
| `src/lib/shopify-order-tags.ts` | tagsAdd / tagsRemove |
| `src/lib/appstle.ts` | Subscription cancel on confirmed fraud |
| `src/lib/inngest/fraud-detection.ts` | Per-order + per-customer + nightly scans |
| `src/lib/inngest/reseller-discovery.ts` | Weekly Amazon SP-API discovery |
| `src/lib/inngest/order-address-fallback.ts` | Address fallback chain |
| `scripts/discover-resellers.ts` | One-shot reseller discovery |
| `scripts/reseller-impact-report.ts` | Impact report |
| `scripts/cancel-and-ban-resellers.ts` | Bulk cancel + ban |
| `scripts/backfill-1yr-addresses.ts` | Address backfill |

## Status / open work

**Shipped:** All five rule types (shared_address, high_velocity, address_distance, name_mismatch, amazon_reseller). Two-pass amazon_reseller matching (normalized exact + Haiku fuzzy). Order hold via `tagsAdd("suspicious")`. `confirmed_fraud` orchestrator short-circuit in `customer-fraud-status.ts`. Weekly reseller discovery scan. Address fallback chain on order ingest.

**Known gaps / not yet shipped:** None identified.

**Recent activity:**
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[chargeback-pipeline]] · [[ai-multi-turn]] · [[../integrations/shopify]] · [[../integrations/appstle]] · [[../tables/fraud_cases]] · [[../tables/fraud_rules]] · [[../tables/known_resellers]] · [[../tables/amazon_asins]] · [[../tables/fraud_action_log]] · [[../inngest/fraud-detection]] · [[../inngest/reseller-discovery]] · [[../inngest/order-address-fallback]]
