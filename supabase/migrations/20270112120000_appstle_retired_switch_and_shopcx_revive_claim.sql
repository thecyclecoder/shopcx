-- appstle_retired switch + the ShopCX revive claim columns.
--
-- 1) The `appstle_retired` kill switch (docs/brain/tables/kill_switches.md). kill_switches' polarity
--    is "a row means the node is switched OFF", so a row keyed node_id='appstle_retired' means the
--    Appstle ENGINE is switched off — retired. MISSING ROW ⇒ Appstle is live, which is today's
--    behaviour. This migration therefore writes NO row: the switch ships OFF (enabled=false) and
--    production does not change until Dylan flips it.
--
--    To turn it ON (Dylan, once Appstle is uninstalled — see docs/brain/integrations/appstle.md):
--      insert into public.kill_switches (node_id, scope, off_by, reason)
--      values ('appstle_retired', 'tool', 'ceo', 'Appstle uninstalled — revive builds on ShopCX from mirror')
--      on conflict (node_id) do nothing;
--    To turn it back OFF: delete from public.kill_switches where node_id = 'appstle_retired';
--
--    Read by src/lib/appstle-retired.ts isAppstleRetired() (own row only — no ancestor cascade).

-- 2) The idempotency claim for buildShopcxFromMirror (src/lib/commerce/shopcx-revive.ts) — mirrors
--    executeMigration's attempt marker on appstle_contract_snapshots:
--      shopcx_revive_claimed_at   compare-and-set claim, stamped BEFORE the Shopify create, so two
--                                 concurrent revives never create two contracts.
--      shopcx_revive_contract_id  the created contract id, recorded IMMEDIATELY after the create and
--                                 BEFORE the billing_source flip, so a retry adopts it.
alter table public.subscriptions
  add column if not exists shopcx_revive_claimed_at timestamptz,
  add column if not exists shopcx_revive_contract_id text;

comment on column public.subscriptions.shopcx_revive_claimed_at is
  'buildShopcxFromMirror claim (compare-and-set) — set before the ShopCX contract create when a never-migrated Appstle sub is revived/changed with appstle_retired on. Null = never attempted.';
comment on column public.subscriptions.shopcx_revive_contract_id is
  'The ShopCX (Shopify) contract buildShopcxFromMirror created for this row, recorded before the billing_source flip so a retry adopts it instead of creating a duplicate.';
