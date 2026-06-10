# coupon_redemptions

Redemption ledger for the [[coupons]] engine — **one row per actual redemption, not per issuance**. This is what makes master/derived coupons cheap: instead of minting a per-customer coupon row for every lead (most never redeem) or pre-generating thousands of rows before an SMS blast, the per-customer code is virtual (`{master.code}-{short_code}`) and a row lands here only when it's truly consumed. Doubles as the redemption-analytics source.

**Primary key:** `id` · **Migration:** `20260610170000_master_coupons.sql`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `coupon_id` | `uuid` | — | → [[coupons]].id — the **master** row for derived codes (or an explicit row) |
| `customer_id` | `uuid` | — | → [[customers]].id — who redeemed |
| `derived_code` | `text` | — | the actual code used, e.g. `WELCOME-GSXN` |
| `order_id` | `uuid` | ✓ | → [[orders]].id (on delete set null) |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id (on delete set null) |
| `redeemed_at` | `timestamptz` | — | default `now()` — the cycle-eligibility cutoff compares against this |
| `created_at` | `timestamptz` | — | |

**Indexes:** `coupon_redemptions_lookup_idx (coupon_id, customer_id, redeemed_at)` powers the eligibility count; `coupon_redemptions_customer_idx (workspace_id, customer_id)` for per-customer history.

## How eligibility is enforced

[[../libraries/coupons]].`resolveDerivedCoupon` rejects a derived code when:

```
count(*) from coupon_redemptions
  where coupon_id = master.id
    and customer_id = owner.id
    and redeemed_at >= master.redemption_cycle_started_at   >= per_customer_limit
```

- **`WELCOME`** — `redemption_cycle_started_at` = epoch, `per_customer_limit` = 1 → counts all-time → **one per customer forever**.
- **Reissuable campaign** (`VIPSALE`/`WEEKEND`) — re-running the campaign bumps the master's `redemption_cycle_started_at` to `now()`, so prior redemptions drop out of the count and the customer is eligible again.

Rows are written by [[../libraries/coupons]].`recordCouponRedemption` at the consumption point (today: `applyCouponToSub`; storefront-checkout application is a documented open item).

## Gotchas

- The ledger is the **only** single-use guard for derived codes — legacy explicit coupons still use `coupons.used_at`. `recordCouponRedemption` picks the right one via `resolved.is_derived`.
- Writes are best-effort (logged on failure) — they must not block a successful charge.

---

[[../README]] · [[coupons]] · [[../libraries/coupons]] · [[customers]] · [[../lifecycles/storefront-checkout]]
