-- Internal-order returns: an internal order (SHOPCX*, no Shopify order) has no Shopify return to
-- mirror, so its returns row carries no shopify_order_gid. Drop the NOT NULL so the internal-return
-- path (src/lib/shopify-returns.ts createFullReturn) can insert a Shopify-less return that still buys
-- an EasyPost label + refunds via Braintree. (Shopify returns keep populating it.)
alter table public.returns alter column shopify_order_gid drop not null;
