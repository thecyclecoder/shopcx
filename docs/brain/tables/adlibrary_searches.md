# adlibrary_searches

Per-(workspace, keyword) last-searched ledger for the AdLibrary sweep — the freshness ledger the Phase 2 gate reads to skip a seed that was already searched inside the window. Phase 1 of [[../specs/adlibrary-search-freshness-gate]]. Owner: [[../functions/growth]] (build: [[../functions/platform]]).

The [[../inngest/creative-finder]] `creative-finder-daily-cron` calls [[../libraries/creative-skeleton]] `sweepSeed` → `searchAds` once per seed EVERY day; the AdLibrary subscription has a fixed monthly search cap (~900/mo, ~67% burned on Amazing Coffee's seed list today). This table stamps every search so Phase 2's `filterSeedsByFreshness` can skip seeds searched within the window (default 7d) BEFORE the `searchAds` call — turning the cron into a precise consumer of the quota instead of a daily re-hitter.

**Best-effort telemetry.** The writer in `sweepSeed` swallows failures (both the Supabase `{ error }` and any throw) — a broken freshness log must NEVER fail the sweep. On write failure the seed simply looks "never searched" to the Phase 2 gate → gets swept next cron (safe fallback: over-search, not under-search).

**No customer_id.** CLAUDE.md's rule for customer-referenced tables (add a Sonnet data tool) does not apply.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `keyword` | `text` | NOT NULL · the exact AdLibrary keyword passed to `searchAds` (`seed.keyword` — either `competitors.search_keyword` or the normalized `brand` fallback; see [[competitors]]) |
| `last_searched_at` | `timestamptz?` | wall-clock of the most recent `searchAds` return. In practice always non-null (the writer stamps `now()`) — nullable so a manually-seeded "never searched" row is representable |
| `last_result_count` | `int?` | ads returned by the last `searchAds` call. NULL when the last search errored |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `adlibrary_searches_touch_updated_at` trigger |

**Unique:** `(workspace_id, keyword)` — one row per (workspace, keyword). The `sweepSeed` writer upserts on this pair so re-sweeping a seed UPDATES the row (no duplicate insert).

**Indexes:** `adlibrary_searches_workspace_last_searched_idx` on `(workspace_id, last_searched_at)` — Phase 2's `filterSeedsByFreshness` filters `where workspace_id = ? and last_searched_at > now() - interval '<window>'`.

## Triggers

- `adlibrary_searches_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()` so the ledger stays honest without app-layer help.

## Who writes / reads

- **Writer:** [[../libraries/creative-skeleton]] `sweepSeed`, after `searchAds` returns. Upserts on `(workspace_id, keyword)` with `last_searched_at = now()` + `last_result_count = ads.length`. Best-effort — errors are logged + swallowed.
- **Reader (Phase 2):** `filterSeedsByFreshness(workspaceId, seeds, maxAgeDays)` in [[../libraries/creative-skeleton]] — returns only seeds whose `last_searched_at` is null OR older than `maxAgeDays`. Applied in [[../inngest/creative-finder]] `creative-finder-daily-cron` between `workspaceSeeds` and the sweep loop, so a fresh seed is skipped BEFORE `searchAds` is called. The manual sweep (`ads/creative-finder.sweep`) accepts `force=true` to bypass the gate.

## Gotchas

- **Telemetry, not the load path.** The writer is best-effort. A degenerate ledger is safe (over-search) — never gate anything that must NOT skip a seed on this table.
- **Keyword is stored verbatim.** `seed.keyword` is `competitors.search_keyword ?? competitors.brand` (see [[competitors]]) — the exact string AdLibrary matches. Do NOT `normalizeBrand`-flatten before writing/comparing.
- **No RLS-exposed writer.** Writes go through the service role from `sweepSeed`; RLS allows workspace-member `SELECT` for future dashboard surfaces + service-role full access.

## Migration

`supabase/migrations/20260810120000_adlibrary_searches.sql` — apply with `npx tsx scripts/apply-adlibrary-searches-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards).

## Related

[[workspaces]] · [[competitors]] · [[creative_skeletons]] · [[../libraries/creative-skeleton]] · [[../inngest/creative-finder]] · [[../integrations/adlibrary]] · [[../specs/adlibrary-search-freshness-gate]] · [[../functions/growth]] · [[../goals/acquisition-research-engine]]
