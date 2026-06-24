-- Persist-to-renewal offer lever — Phase 2 guardrail surface (margin-floor) + Phase 1 taxonomy
-- seed (docs/brain/specs/storefront-renewal-offer-lever.md). Extends the deferred activation
-- lever the parent (storefront-dynamic-renewal-offers P1) left dormant.
--
-- 1. storefront_optimizer_policy.min_renewal_margin_pct — the workspace-level FLOOR the agent
--    checks every offer proposal against. An offer whose modeled renewal margin drops below
--    this is REFUSED at propose time and escalated to Growth + CFO via director_activity —
--    it never reaches a normal Build/Approve card (operational-rules § North star margin rail).
--    Default 0.40 = 40% — a conservative starting rail; the Growth director / CFO tune it on
--    the policy row. cogs_source_missing on the offer row keeps the audit honest when COGS
--    isn't available (the floor SOFT-passes; the card carries the missing-COGS warning).
-- 2. Seed the persist_to_renewal_offer chapter + its two component levers (subscribe_discount
--    override, fixed renewal price). The agent picks ONE via nextLeverToTest like any other
--    chapter-component pair — the offer lever is just one more lever in the M2 map.
-- 3. Seed each in-scope optimizer-policy row with the floor's default (one-shot upsert so the
--    floor exists even on policies created before this migration).

-- ── 1. storefront_optimizer_policy.min_renewal_margin_pct ─────────────────────
alter table public.storefront_optimizer_policy
  add column if not exists min_renewal_margin_pct numeric not null default 0.40
    check (min_renewal_margin_pct >= 0 and min_renewal_margin_pct <= 1);

-- ── 2. seed persist_to_renewal_offer chapter + components ─────────────────────
-- One chapter lever (the offer "chapter" of the storefront — a persist-to-renewal pricing offer
-- is structurally its own lever, not a sub-component of pricing_table since it affects RENEWAL
-- not the first-order price card). Two component levers the agent actually proposes on.
insert into public.storefront_levers (lever_key, chapter, level, label, prior, default_scope, description)
values
  ('persist_to_renewal_offer', 'persist_to_renewal_offer', 'chapter', 'Persist-to-renewal offer', 0.72, 'general',
   'A scoped, time-boxed pricing offer that persists to renewal (subscribe-discount override OR fixed renewal price). ALWAYS approval-gated — bleeds margin on every renewal.')
on conflict (lever_key) do nothing;

insert into public.storefront_levers (lever_key, chapter, level, parent_lever_id, label, prior, default_scope, description)
select v.lever_key, 'persist_to_renewal_offer', 'component', p.id, v.label, v.prior, v.default_scope, v.description
from (values
  ('renewal_discount_pct', 'Subscribe-discount override (renewal)', 0.55, 'general',
   'Override the rule''s subscribe_discount_pct on the offer arm — applies to first order AND every renewal until expiry.'),
  ('renewal_fixed_price',  'Fixed renewal price',                   0.50, 'general',
   'Pin a per-unit renewal price on the offer arm — the persist-to-renewal lever''s sharpest form.')
) as v(lever_key, label, prior, default_scope, description)
cross join public.storefront_levers p
where p.lever_key = 'persist_to_renewal_offer'
on conflict (lever_key) do nothing;

-- ── 3. backfill floor on existing policy rows (defensive: the DEFAULT already covers fresh
--      rows, this catches any row written between the ADD COLUMN and a re-run that dropped
--      the default — idempotent). ──
update public.storefront_optimizer_policy
  set min_renewal_margin_pct = 0.40
  where min_renewal_margin_pct is null;
