-- Track redemptions of Shopify-sourced coupons (no row in our `coupons` table).
-- Renewal now live-reads the Shopify discount and records the redemption keyed by
-- code, so a one-time coupon (appliesOncePerCustomer / usageLimit=1 / recurring
-- cycle exhausted) isn't re-granted. `derived_code` already stores the code; we
-- just need coupon_id to be optional for code-only (Shopify) redemptions.
alter table coupon_redemptions alter column coupon_id drop not null;
create index if not exists coupon_redemptions_ws_cust_code_idx
  on coupon_redemptions (workspace_id, customer_id, derived_code);
