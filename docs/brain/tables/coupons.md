# coupons

Our own discount-code table — the source of truth for internal coupons (will replace Shopify discounts). The coupon engine ([[../libraries/coupons]]) resolves a code from here **first** ("internal wins"), then falls back to a real-time Shopify discount-code lookup. Discounts are **entire-order** scoped (we ignore Shopify product scope for internal subs) and stack on subscribe-and-save + the quantity break.

**Primary key:** `id` · **Migration:** `20260608120000_coupons.sql`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `code` | `text` | — | unique per workspace, case-insensitive (`coupons_workspace_code_idx`) |
| `type` | `text` | — | `percentage` \| `fixed_amount` (CHECK) |
| `value` | `int4` | — | percentage: 0-100 · fixed_amount: cents |
| `scope` | `text` | — | always `order` |
| `recurring_cycle_limit` | `int4` | ✓ | `1` (one charge) · `N` · `null` (forever) — read from Shopify's setting for Shopify codes |
| `customer_id` | `uuid` | ✓ | → [[customers]].id · when set, only this customer can use it |
| `single_use` | `bool` | — | default false; burned via `used_at` when applied |
| `used_at` | `timestamptz` | ✓ | set when a single-use coupon is consumed |
| `stackable` | `bool` | — | default true |
| `created_at` / `updated_at` | `timestamptz` | — | |

## How it's applied

The resolver normalizes a coupon into an entry on [[subscriptions]].`applied_discounts`:
`{ code, type, value, recurring_cycle_limit, remaining_cycles, source }`. The **internal renewal scheduler** ([[../inngest/internal-subscription-renewals]]) computes the entire-order discount from `applied_discounts`, applies it to the charge, decrements `remaining_cycles` per successful charge, and drops the entry at 0 (so "1 charge" auto-expires). See [[../libraries/coupons]].`computeAppliedDiscountCents`.

## Gotchas

- **Customer-scoped + single_use** coupons (minted by the smart popup via `mintCustomerCoupon`) only resolve for their `customer_id` and only once.
- Tax is currently quoted on the **pre-discount** subtotal (Avalara); applying the discount to the taxable base is a documented refinement.
- The grandfathered-floor guardrail runs on the Appstle/Shopify coupon path; adding it to the internal path is a refinement.

---

[[../README]] · [[../libraries/coupons]] · [[../lifecycles/subscription-billing]] · [[../specs/storefront-mvp]]
