-- winners-flow — LONGITUDINAL winner tracking. The proven-winner signal is OURS: a competitor keeps
-- paying to run an ad *because it converts*, so an ad that persists across our own weekly sweeps is the
-- proof — no dependence on AdLibrary's opaque per-scan tier/score (which came back "loser" for every major
-- brand and whose composite just tracked a mis-parsed recency number). We re-observe every ad each sweep:
-- new → full ingest+vision; already-seen → cheap bump (last_seen + sweep count, NO re-vision); vanished →
-- marked inactive (the competitor killed it). `winner_score`/`winner_tier` are REPURPOSED to our signal.
alter table public.creative_skeletons
  add column if not exists our_first_seen  timestamptz,  -- when WE first observed this ad (set once)
  add column if not exists our_last_seen   timestamptz,  -- most recent sweep we saw it live
  add column if not exists observed_sweeps integer not null default 1,  -- how many sweeps we've seen it in
  add column if not exists still_active    boolean not null default true; -- present in its competitor's latest sweep

comment on column public.creative_skeletons.our_first_seen is
  'winners-flow longitudinal: when OUR sweep first observed this ad. Persistence = our_last_seen - our_first_seen '
  'is the transparent winner signal (a still-running competitor ad converts). Backfilled to created_at for legacy rows.';
comment on column public.creative_skeletons.winner_score is
  'REPURPOSED (winners-flow longitudinal): OUR observed persistence in DAYS (our_last_seen - our_first_seen), '
  'not AdLibrary''s opaque composite. The ranking signal for proven winners.';
comment on column public.creative_skeletons.winner_tier is
  'REPURPOSED (winners-flow longitudinal): OUR persistence tier — new (<7d) | building (7-20d) | proven (>=21d) '
  '| retired (still_active=false, competitor killed it). Not AdLibrary''s tier.';

-- Backfill existing rows: start the observation clock now (we can''t know true prior persistence).
update public.creative_skeletons
  set our_first_seen = coalesce(our_first_seen, created_at),
      our_last_seen  = coalesce(our_last_seen, created_at),
      winner_score   = 0,
      winner_tier    = 'new'
  where source = 'adlibrary' and our_first_seen is null;

create index if not exists creative_skeletons_persistence_idx
  on public.creative_skeletons (workspace_id, still_active, winner_score desc) where source = 'adlibrary';
