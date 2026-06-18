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

Plus two rule-**independent** layers that run inside `checkOrderForFraud` regardless of `fraud_rules` rows: **repeat-offender matching** (vs `confirmed_fraud` orders) and **velocity signals** (`bin_velocity` / `email_domain_velocity` / `surname_velocity`). See the dedicated sections below.

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

## Repeat-offender matching (confirmed-fraud similarity)

After the rules + AI screen, `checkOrderForFraud` compares each new order against every `confirmed_fraud` order for overlap — this is what catches a known fraudster reordering under a tweaked identity. Match types (any one → hold + `confirmed_fraud_match` case):

- exact email · gmail-alias (same base, different `+tag`)
- shipping/billing address (street + zip), incl. ship↔bill cross-match
- same last name + same address
- exact same first+last name
- **same custom email DOMAIN** (non-freemail, e.g. `@safelywater.com`) — a ring spins up fresh local parts on a throwaway domain to beat exact-email matching; `FREEMAIL_DOMAINS` excludes gmail/yahoo/etc. so coincidental same-provider orders don't trip it.
- **fuzzy name** — same last name + first-name containment (≥4 chars), catching padding like `stephen` → `benstephen`/`estephen`.

> The last two were added 2026-06-11 after the **Stephen Reinard ring** (29 customers, `@safelywater.com`/`@chadscaler.com`/`@bowlingdog.com`) landed an order (`SC132418`, "benstephen reinard") that beat every rule at once: fresh address (no shared-address / distance — he made ship=bill), padded first name (beat exact-name), and a fresh local part on the ring's domain (beat exact-email). Domain + fuzzy-name matching now catches that class.

## Velocity signals (rule-independent, real-time)

Repeat-offender matching only catches rings **after** one of their orders is `confirmed_fraud`. Velocity signals catch a ring on its **own internal repetition** — before we've confirmed anyone — by looking at what survives identity rotation. Run inside `checkOrderForFraud` (rule-independent, like the AI screen), 30-day window, each opens a `status='open'` case (Dylan confirms in the UI — that path cancels subs + refunds to head off chargebacks) and tags **every order in the ring** `suspicious`. De-duped by `evidence->>velocity_key` so a ring collapses into one case that refreshes:

| slug | Fires when | velocity_key |
|---|---|---|
| `bin_velocity` | One card **BIN** on ≥4 orders across ≥2 customers **AND** a concentration corroborator — one card swiped ≥3×, or the cluster narrowing to ≤2 cardholder surnames or ≤2 shipping zips. The corroborator is essential: a shared BIN alone is a popular-bank false positive (Visa `414720` = 17 orders / 16 real customers, all different cards/names/zips). Real rings collapse on an axis; legit crowds don't. | `bin:{bin}` |
| `email_domain_velocity` | ≥4 distinct customers (≥4 distinct addresses) on one **custom** (non-freemail) email domain. A ring spinning up throwaway accounts on a domain it controls. | `domain:{domain}` |
| `surname_velocity` | ≥4 new accounts sharing a **surname**, with ≥2 on custom (non-freemail) domains. Tying to custom domains is what suppresses common-surname false positives — a cluster of freemail "Adams" doesn't fire; 5 fresh `@safelywater.com` "Reinard"s does. | `surname:{surname}` |

> Added 2026-06-11 from the Reinard card investigation: pulling each order's Shopify transaction showed he rotated **10 distinct cards** (9 sharing Amex BIN `370021`) across the ring, every order AVS=Y / CVV=M (he holds the real billing data, so AVS/CVV never decline him). Domain + surname velocity already fire on the existing Reinard data; the dry-run also surfaced a **second ring** (surname "porth", 5 fresh custom-domain accounts — banned + closed). **BIN data is captured going forward** — `checkOrderForFraud` now fetches the Shopify card transaction whenever `payment_details.card_bin` is missing and **merges** `card_bin`/`card_last4`/`card_company`/`card_name`/`card_exp` into `orders.payment_details` (never clobbering the checkout breakdown that also lives there). Seed history with `scripts/_backfill-card-bins.ts` (bounded by date — only non-subscription orders, since a subscriber's recurring renewals on one card must not trip the rule).

> **False-positive lesson — the freemail allowlist must be comprehensive (2026-06-18).** `email_domain_velocity` opened case `3e1e138c` on 4 unrelated long-time customers (29 / 15 / 8 / 5 orders since 2024, in AZ/MI/MO/CA) whose only link was `@netscape.net` — a legacy freemail provider the old hand-seeded ~26-domain `FREEMAIL_DOMAINS` set didn't list (132 netscape.net customers exist in the workspace; 32.7k on aol.com). It was confirmed + actioned (4 portal-banned, 4 subs cancelled, 1 order refunded) before review. **Fix:** `FREEMAIL_DOMAINS` now loads the vendored `free-email-domains` list (~12.3k domains) from `src/lib/freemail-domains.json` — see [[../libraries/fraud-detector]]. **Remediation:** all 4 un-banned, subs reactivated (`resume` un-cancels — see [[../integrations/appstle]]), Linda West's refunded SC132897 re-placed as SC132899 via order-now, case dismissed. A sweep of all 82 confirmed cases found this was the **only** freemail-domain false positive. Note the AI analysis compounded it by reading the bulk-import `customers.created_at` (all 4 within seconds on 2026-03-24) as "4 accounts created in a 180-second window" — that timestamp is sync time, not signup time; real first orders were 2024.

> **BIN concentration corroborator (essential).** Backfilling 30 days surfaced six BINs over the order/customer thresholds — but four were **popular consumer Visa BINs** (`414720`, `440066`, `410039`, `601100`): dozens of unrelated legit customers with fully diverse names, addresses, and cards who simply bank with the same issuer. Holding them would be a false positive. The rule therefore requires a second signal that a real ring shows and a crowd doesn't: **one card swiped ≥3×**, or the cluster collapsing to **≤2 surnames** or **≤2 shipping zips**. With it, only `370021` (Reinard — card reused 4×) and `558668` (Porth — 1 card, 1 name, 1 zip, 4×) fire; the four bank BINs clear.

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

**Shipped:** All five rule types (shared_address, high_velocity, address_distance, name_mismatch, amazon_reseller). Two-pass amazon_reseller matching (normalized exact + Haiku fuzzy). Order hold via `tagsAdd("suspicious")`. `confirmed_fraud` orchestrator short-circuit in `customer-fraud-status.ts`. Weekly reseller discovery scan. Address fallback chain on order ingest. Repeat-offender matching (incl. custom-domain + fuzzy-name, 2026-06-11). **Velocity signals** — `bin_velocity` / `email_domain_velocity` / `surname_velocity` (2026-06-11), with Shopify card-BIN capture merged into `orders.payment_details`. **Comprehensive freemail allowlist** — `FREEMAIL_DOMAINS` now loads the vendored ~12.3k-domain `free-email-domains` list from `src/lib/freemail-domains.json` (2026-06-18), replacing the hand-seeded ~26-domain set that caused the `@netscape.net` false positive.

**Known gaps / not yet shipped:** `bin_velocity` only sees BINs captured since 2026-06-11 (forward-filling as orders flow); run `scripts/_backfill-card-bins.ts` to seed history.

**Recent activity:**
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:** None.

## Related

[[ticket-lifecycle]] · [[chargeback-pipeline]] · [[ai-multi-turn]] · [[../integrations/shopify]] · [[../integrations/appstle]] · [[../tables/fraud_cases]] · [[../tables/fraud_rules]] · [[../tables/known_resellers]] · [[../tables/amazon_asins]] · [[../tables/fraud_action_log]] · [[../inngest/fraud-detection]] · [[../inngest/reseller-discovery]] · [[../inngest/order-address-fallback]]
