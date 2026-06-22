# meta-structure-upsert fails PGRST205 — meta_campaigns/adsets/ads/insights_daily tables never created in prod (skipped migration) ✅

**Owner:** [[../functions/growth]] · **Parent:** fixes a deploy gap in [[../specs/storefront-iteration-engine]]; root cause behind [[../specs/meta-insights-ingest-empty-fix]]; surfaced via [[../specs/error-feed-monitoring]] + [[../specs/control-tower]] · **Verdict:** real-bug
**Repair-root-cause:** `supabase/migrations/20260618140000_meta_performance_tables.sql (apply to prod via its apply-script + notify pgrst, reload schema; verifies writers in src/lib/meta/performance.ts then succeed, then re-fire meta/sync-performance for account d6d619a5)::real-bug`
**Repair-signature:** `supabase:a83daae8cafbcf4c`
**Repair-signature:** `inngest:d2d9c97c049e2b0b`

Apply the one skipped migration so the Meta performance ingest can persist campaign/adset/ad structure and daily insights, unblocking the iteration engine's ad/adset/campaign-grain scorecards and non-degenerate ROAS.

## Problem (from Control Tower signature `supabase:a83daae8cafbcf4c`)
Direct information_schema inspection of prod shows public.meta_campaigns, meta_adsets, meta_ads, and meta_insights_daily DO NOT EXIST (column count 0, 'relation does not exist'), only ad_campaigns. Their creating migration 20260618140000_meta_performance_tables.sql was never applied, though the feature's later migrations (20260619140000 meta_attribution_daily, 20260619230000 iteration_scorecards_daily) did apply. ingestMetaPerformance in src/lib/meta/performance.ts therefore upserts into a non-existent meta_campaigns and fails every write with PGRST205 (sample: op=meta-structure-upsert, total=67, persisted=0, hint 'Perhaps you meant the table public.ad_campaigns'). This has failed silently since the June 18 rollout and is the real reason the iteration engine's economics data is degenerate.

**Likely target:** `supabase/migrations/20260618140000_meta_performance_tables.sql (apply to prod via its apply-script + `notify pgrst, 'reload schema'`; verifies writers in src/lib/meta/performance.ts then succeed, then re-fire meta/sync-performance for account d6d619a5)`

## Phase 1 — close it ✅
**Resolved 2026-06-22 (manual apply — exactly as the Repair Agent prescribed).** Applied `20260618140000_meta_performance_tables.sql` to prod via a direct PG connection + `NOTIFY pgrst, 'reload schema'`, then re-fired `meta/sync-performance` for account `d6d619a5`. The four tables now exist and populate: `meta_campaigns` 67, `meta_adsets` 133, `meta_ads` 791, `meta_insights_daily` 1611 rows; `iteration_scorecards_daily` now has `ad`/`adset`/`campaign` levels (the previously-empty primary grain). The originating `supabase:a83daae8cafbcf4c` / `inngest:d2d9c97c049e2b0b` error_events are resolved. Recurrence is now guarded by [[control-tower-migration-drift-check]] (diffs migration-created tables vs the live schema). The fail-loud that surfaced this in the first place shipped in [[meta-insights-ingest-empty-fix]].

## Verification
- ✅ `meta_campaigns`/`meta_adsets`/`meta_ads`/`meta_insights_daily` exist + populated; no new PGRST205 on `meta/sync-performance`; the Control Tower supabase feed has no open `meta-structure-upsert` incident.

> Authored by the box Repair Agent from Control Tower signature `supabase:a83daae8cafbcf4c` (verdict: real-bug). Commission the build from the Control Tower / Roadmap board.
