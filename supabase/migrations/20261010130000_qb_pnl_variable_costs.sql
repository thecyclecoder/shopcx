-- CFO P&L: break the two VARIABLE costs out of OpEx so "Fixed OpEx" (cost to operate) is clean.
--   digital_advertising    — the "60510 Digital Advertising" line (Facebook/Google/Amazon ad spend)
--   transaction_fees       — the "61508 Platform Transaction Fees" group (Amazon Seller/Shopify/PayPal/
--                            Braintree/Walmart transaction fees)
-- Both live INSIDE the P&L Expenses section but are variable; Fixed OpEx = total_expenses − these two.
-- Populated by re-parsing the raw report already stored per month (no QuickBooks re-pull).
alter table public.qb_pnl_snapshots add column if not exists digital_advertising numeric;
alter table public.qb_pnl_snapshots add column if not exists transaction_fees numeric;

-- Profit "bites" the founder tracks (all extracted from the stored raw, no re-pull):
--   refunds                — "48300 Refunds" (contra-revenue; stored as positive magnitude)
--   chargebacks            — "48100 Chargebacks" (contra-revenue; stored as positive magnitude)
--   inventory_adjustments  — "53100 Inventory Shrinkage" (COGS; positive cost)
alter table public.qb_pnl_snapshots add column if not exists refunds numeric;
alter table public.qb_pnl_snapshots add column if not exists chargebacks numeric;
alter table public.qb_pnl_snapshots add column if not exists inventory_adjustments numeric;

-- discounts_coupons — "48200 Discounts & Coupons" (contra-revenue; positive magnitude).
-- fixed_opex        — total_expenses − (OpEx-resident Digital Advertising line 60510) − transaction_fees.
--   Stored (not derived in the UI) because the pre-2025 ad bridge means the ad-SPEND series ≠ the
--   OpEx ad line, so Fixed OpEx can't be recomputed from the bridged digital_advertising alone.
alter table public.qb_pnl_snapshots add column if not exists discounts_coupons numeric;
alter table public.qb_pnl_snapshots add column if not exists fixed_opex numeric;
