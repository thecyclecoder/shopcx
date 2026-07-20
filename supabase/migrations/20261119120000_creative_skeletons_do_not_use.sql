-- flag-a-competitor-ad-do-not-use — Phase 1: per-ad exclusion flag on the
-- competitor-imitation library. A proven long-runner is NOT automatically a good imitation
-- base (the Magic Mind display-box packshot outranks nothing in the Onnit "Lock in when it
-- matters most" ad on winner-tier / days-running, yet is unusable). The CEO — and eventually
-- Max — marks a weak ad as do_not_use; `queryProvenAngles` skips flagged rows so a lame
-- imitation base can never reach Dahlia's shelf. Per-AD, not per-advertiser: a brand can
-- hold both great and lame ads. See docs/brain/tables/creative_skeletons.md +
-- docs/brain/libraries/creative-sourcing.md and the spec at
-- .box/spec-flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded.md.
alter table public.creative_skeletons
  add column if not exists do_not_use        boolean not null default false,
  add column if not exists do_not_use_reason text,
  add column if not exists do_not_use_by     text,  -- 'ceo' | 'max' | actor id
  add column if not exists do_not_use_at     timestamptz;

-- NOTE: `comment on ... is` takes a string LITERAL, not an expression — a `||` here is a parse
-- error (42601) that leaves the migration version unrecorded, so migration-drift re-runs the file
-- every tick forever. The newlines below already concatenate these literals (SQL-standard
-- continuation); no operator is needed. Guarded by scripts/_check-sql-comment-literals.ts.
comment on column public.creative_skeletons.do_not_use is
  'flag-a-competitor-ad-do-not-use Phase 1: per-ad exclusion. When true, queryProvenAngles '
  'in src/lib/ads/creative-sourcing.ts filters this row out of imitation-angle selection so '
  'Dahlia never riffs on a lame competitor ad. Preserved across scout re-observation '
  '(ingestAd upsert + reobserveAd leave the column untouched by design).';
comment on column public.creative_skeletons.do_not_use_by is
  'who flagged this ad — ''ceo'' for a manual CEO flag from the competitor library, ''max'' '
  'for the Phase-3 imitation-quality grader''s auto-flag (still surfaced for CEO review — '
  'never a silent proxy-optimizer).';

-- Partial index so the queryProvenAngles filter (`do_not_use = false`) doesn't have to scan
-- flagged rows in the shelf; matches the (workspace_id, product_id) scope the query narrows on.
create index if not exists creative_skeletons_do_not_use_idx
  on public.creative_skeletons (workspace_id, product_id) where do_not_use;
