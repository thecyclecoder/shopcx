-- Per-adset "the signal is trustworthy from here" floor.
--
-- CEO 2026-08-25. Three legacy test adsets were minted before the existing-customer exclusion
-- feature and have been running with NO `excluded_custom_audiences` — so existing customers could
-- convert inside a "cold" test, inflating purchases and flattering CPA. That is precisely the number
-- the crown decision rests on, and `crownUpperBoundCpaCents` does nothing about it: the confidence
-- bound guards against a SMALL sample, not a CONTAMINATED one.
--
-- Fixing the targeting only cleans the signal GOING FORWARD, while the crown reads LIFETIME
-- spend/purchases — so a repaired adset would still be judged on a mixed sample. This column records
-- when the signal became trustworthy so `activeAdsetLifetimeMetrics` can discount everything before
-- it automatically, instead of relying on someone remembering at crown time.
--
-- NULL (the default, and every other adset) = the whole history counts — behaviour unchanged.
--
-- Safe against the structure sync: `syncMetaStructure`'s upsert into meta_adsets lists its columns
-- explicitly, so ON CONFLICT DO UPDATE never touches this one.
alter table public.meta_adsets
  add column if not exists clean_signal_since timestamptz;

comment on column public.meta_adsets.clean_signal_since is
  'Insights STRICTLY AFTER this day are trustworthy for crown/kill decisions; earlier days are discounted by activeAdsetLifetimeMetrics (src/lib/media-buyer/meta-cpa-signal.ts). Set when an adset''s audience is repaired mid-flight — e.g. adding the existing-customer exclusions a legacy adset was minted without. The cutover DAY itself is excluded too, since it is partly pre-repair. NULL = count the full history (the default for every adset).';
