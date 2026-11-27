-- Store, per discontinued product, the replacement product to offer on restart and the
-- per-unit price the customer pays for it AFTER all discounts (S&S, quantity breaks),
-- before tax and shipping. DB-driven so the restart path never hardcodes the offer
-- (CLAUDE.md: journeys / remedies / offers are never hardcoded).
--
-- Seeds Apple Cider Vinegar Gummies (discontinued, no restock — CEO 2026-10-01) → Ashwavana
-- Zen Relax at $29.95 (CEO 2026-11-27; Sleep Gummies is out of stock). The restart path reads
-- these via replacementForDiscontinued (src/lib/migrate-to-internal.ts).

alter table public.products add column if not exists discontinued_replacement_product_id uuid references public.products(id);
alter table public.products add column if not exists discontinued_replacement_price_cents integer;

-- Idempotent seed: ACV Gummies → Ashwavana Zen Relax @ 2995. Guarded on the column still
-- being null so a later manual edit is never clobbered by a re-run.
update public.products
  set discontinued_replacement_product_id = '48bfa48c-b8db-42f9-9303-19c70ab8e7a1',
      discontinued_replacement_price_cents = 2995
  where id = 'ad466a2f-061e-4692-a3d3-f672797fcecf'
    and discontinued_replacement_product_id is null;
