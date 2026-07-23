# coupons

Our own discount-code table — the source of truth for internal coupons (will replace Shopify discounts). The coupon engine ([[../libraries/coupons]]) resolves a code from here **first** ("internal wins"), then falls back to a real-time Shopify discount-code lookup. Discounts are **entire-order** scoped (we ignore Shopify product scope for internal subs) and stack on subscribe-and-save + the quantity break.

**Primary key:** `id` · **Migrations:** `20260608120000_coupons.sql`, `20260610170000_master_coupons.sql`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `code` | `text` | — | unique per workspace, case-insensitive (`coupons_workspace_code_idx`). For a master, this is the **prefix** (e.g. `WELCOME`) |
| `type` | `text` | — | `percentage` \| `fixed_amount` (CHECK) |
| `value` | `int4` | — | percentage: 0-100 · fixed_amount: cents |
| `scope` | `text` | — | always `order` |
| `recurring_cycle_limit` | `int4` | ✓ | `1` (one charge) · `N` · `null` (forever) — read from Shopify's setting for Shopify codes |
| `customer_id` | `uuid` | ✓ | → [[customers]].id · when set, only this customer can use it |
| `single_use` | `bool` | — | default false; burned via `used_at` when applied |
| `used_at` | `timestamptz` | ✓ | set when a single-use coupon is consumed |
| `stackable` | `bool` | — | default true |
| `is_master` | `bool` | — | default false. A **master** defines terms once; per-customer codes are virtual `{code}-{short_code}` (see below) |
| `per_customer_limit` | `int4` | ✓ | master only — max redemptions per customer within the current cycle (`WELCOME` = 1) |
| `reissuable` | `bool` | — | master only — can a campaign reset the cycle? `WELCOME` = false; `VIPSALE`/`WEEKEND` = true |
| `redemption_cycle_started_at` | `timestamptz` | ✓ | master only — redemptions before this are ignored. Re-issuing bumps it to `now()`. `WELCOME` = epoch (counts forever) |
| `valid_until` | `timestamptz` | ✓ | master only — offer expiry (null = none) |
| `created_at` / `updated_at` | `timestamptz` | — | |

## Master coupons + derived per-customer codes

To avoid writing a coupon row for every issued lead (most never redeem) **and** pre-generating thousands of rows before an SMS blast, per-customer codes are **virtual**:

```
{master.code}-{customers.short_code}   →   WELCOME-GSXN
```

`short_code` is the same permanent 5-char Crockford code used for SMS shortlinks ([[customers]]). [[../libraries/coupons]].`resolveCoupon` splits the typed code on the **last hyphen**, matches the master by prefix, resolves the suffix → customer via `short_code`, and **binds** redemption to that customer (the suffix is guessable, so only its rightful owner may redeem). Terms come from the master; **single-use is enforced by the [[coupon_redemptions]] ledger** — a row written only on actual redemption, never on issuance.

- **`WELCOME`** (seeded for Superfoods): 15% off, first charge only, **one per customer forever** (cycle = epoch, not reissuable). Replaces the per-row `mintCustomerCoupon` path for the smart popup ([[../lifecycles/storefront-checkout]]).
- **Campaign masters** (`VIPSALE`, `WEEKEND`, …): `reissuable=true`. SMS marketing appends each recipient's `short_code` at send; re-running the campaign bumps `redemption_cycle_started_at` so customers are eligible again.

A bare master code (no suffix) is **never** directly usable — `resolveCoupon` skips `is_master` rows on exact match and only resolves them via the derived path.

## How it's applied

The resolver normalizes a coupon into an entry on [[subscriptions]].`applied_discounts`:
`{ code, type, value, recurring_cycle_limit, remaining_cycles, source }`. The **internal renewal scheduler** ([[../inngest/internal-subscription-renewals]]) computes the entire-order discount from `applied_discounts`, applies it to the charge, decrements `remaining_cycles` per successful charge, and drops the entry at 0 (so "1 charge" auto-expires). See [[../libraries/coupons]].`computeAppliedDiscountCents`.

## Gotchas

- **Coupons apply only to active subscriptions.** Both `subscriptionApplyCoupon` ([[../libraries/subscription-items]]) and `applyCouponToSub` ([[../libraries/coupons]]) check [[../tables/subscriptions]].`status` — refusing `'paused'`, `'cancelled'`, or null — via the `couponApplicableToSubStatus` guard. Discounts on non-active subs are structurally invalid: they silently discount a future renewal the customer didn't earn (ticket f9e28d57, SC135320 double-payout defect). The apply returns `{ success: false, error: 'subscription_not_active' }` on a non-active sub.
- **Customer-scoped + single_use** coupons (legacy `mintCustomerCoupon` path) only resolve for their `customer_id` and only once. New popup leads use the **derived `WELCOME-{short_code}` master** instead (no per-row mint).
- **Derived codes bind to the owner:** `resolveCoupon` rejects a `{PREFIX}-{short_code}` code unless `customerId` is passed AND equals the customer the suffix resolves to. Anonymous/unbound contexts can't redeem a derived code.
- Tax is currently quoted on the **pre-discount** subtotal (Avalara); applying the discount to the taxable base is a documented refinement.
- The grandfathered-floor guardrail runs on the Appstle/Shopify coupon path; adding it to the internal path is a refinement.

---

[[../README]] · [[../libraries/coupons]] · [[../lifecycles/subscription-billing]] · [[../lifecycles/storefront-checkout]]
