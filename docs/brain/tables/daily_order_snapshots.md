# daily_order_snapshots

Per-day Shopify orders summary for analytics dashboards.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `snapshot_date` | `date` | — |  |
| `store_timezone` | `text` | — | default: `'America/Chicago'` |
| `recurring_count` | `int4` | — | default: `0` |
| `recurring_revenue_cents` | `int4` | — | default: `0` |
| `new_subscription_count` | `int4` | — | default: `0` |
| `new_subscription_revenue_cents` | `int4` | — | default: `0` |
| `one_time_count` | `int4` | — | default: `0` |
| `one_time_revenue_cents` | `int4` | — | default: `0` |
| `replacement_count` | `int4` | — | default: `0` |
| `replacement_revenue_cents` | `int4` | — | default: `0` |
| `total_count` | `int4` | — | default: `0` |
| `total_revenue_cents` | `int4` | — | default: `0` |
| `shopify_count` | `int4` | ✓ | Shopify's OWN count for the day (GraphQL `created_at:<date>`). `null` = validation didn't run |
| `shopify_mismatch` | `bool` | ✓ | default: `false` · true when `shopify_count` ≠ the count of **Shopify-origin** DB orders. See § below |
| `native_count` | `int4` | — | default: `0` · orders that day with **no `shopify_order_id`** (ShopCX-native). Excluded from the mismatch comparison |
| `utc_start` | `timestamptz` | — |  |
| `utc_end` | `timestamptz` | — |  |
| `computed_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("daily_order_snapshots")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## ⭐ The mismatch check counts Shopify-origin orders only

`shopify_mismatch` compares Shopify's own order count against **only those DB orders that carry a
`shopify_order_id`** — never `total_count`, and never `total_count + replacement_count`.

**Why.** Since the Braintree migration off Appstle/Shopify, a growing share of real revenue is
booked by orders that exist only in ShopCX and have no Shopify counterpart: `storefront`,
`internal_subscription_renewal`, and comp orders (their order numbers look like `SHOPCX147`).
Shopify cannot count them and never will. The check originally compared the full DB total, so it
flagged **every single day** as the native share grew — and the monthly delta reconciled *exactly*
to the native order count, which is what proved it was a false positive rather than a sync gap:

| Month | mismatch delta | ShopCX-native orders |
|---|---|---|
| 2026-06 | −40 | 40 |
| 2026-07 | −66 | 66 |
| 2026-08 | −118 | 118 |

Cost of the bug: 86 of the 99 days to 2026-09-07 flagged, **676** duplicate "Order sync mismatch"
cards, a self-heal cron re-firing paginated Shopify GraphQL sweeps on days that could never heal,
and — the real damage — a genuine sync gap would have been invisible under the noise. Fixed
2026-09-08; the recompute cleared 87 of 133 flagged rows and newly flagged **zero**.

## Gotchas

- **Never compare `shopify_count` to `total_count`.** `total_count` excludes replacements *and*
  includes ShopCX-native orders. The only like-for-like basis is Shopify-origin orders
  (`shopify_order_id is not null`); `native_count` records the population deliberately excluded,
  so a row explains its own delta without re-deriving it.
- **One alert card per (workspace, date).** [[../inngest/daily-order-snapshot]]'s self-heal re-fires
  each flagged day for 7 days; the insert used to be unconditional, producing 8 cards per day. The
  insert is now guarded on an existing card for that date.
- **A day that stays flagged past 7 days is a real unrecovered gap.** The self-heal window is
  `snapshot_date >= now() - 7d`, so a day that never heals simply ages out and keeps its flag
  forever. That is by design — but it means "still flagged" ≠ "still being retried."
- **The UTC window is built from a hardcoded `centralOffsetHours = 5` (CDT).** For CST months
  (Nov–Mar) that is an hour off, which shifts orders across the day boundary. 43 of the 46 rows
  still flagged after the 2026-09-08 fix sit in Jan–early-Mar 2026 with a **net delta of ~0** —
  orders moved between adjacent days rather than going missing. Unproven but strongly indicated;
  it cannot recur until Nov 2026. Compare [[../libraries/qb-close-sync-sources]] `storeLocalDate`,
  which does this correctly via `Intl.DateTimeFormat`.
- `shopify_count is null` means validation never ran (no Shopify token, or the GraphQL call
  failed) — it is **not** a zero. The mismatch flag is left untouched in that case.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
