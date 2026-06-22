# Control Tower — migration-drift check (schema vs migrations) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower]] + [[error-feed-monitoring]]. · **Found in use 2026-06-22:** migration `20260618140000_meta_performance_tables.sql` was **silently skipped** in the prod apply pipeline — `meta_campaigns`/`meta_adsets`/`meta_ads`/`meta_insights_daily` never existed, every upsert hit `PGRST205`, and (pre-`meta-insights-ingest-empty-fix`) the error was swallowed → the iteration engine had **empty ROAS data for weeks**, found only by manual investigation. Nothing surfaced the drift.

A migration that doesn't apply is invisible: the code references a table, the table isn't there, and unless something fails loud (it usually doesn't), it degrades silently. This is exactly the silent-degradation class the Control Tower exists to catch — but it has no schema-vs-migrations check today.

## Model
- **The check:** parse every `supabase/migrations/*.sql` for `create table [if not exists] (public.)?<name>`, collect the set of tables the migrations *should* have created, and diff against the **live schema** (`information_schema.tables where table_schema='public'`). Any created-table that's **missing** = a silently-unapplied migration → surface it.
- **Where it runs:** the deployed Next runtime can't read the `.sql` files (not bundled), so run it where the repo + DB both exist — **the build box** (a periodic job, alongside its other scheduled work; it has the migration files in the working tree and an admin DB connection), OR a build-time generated `expected-tables` manifest the Control Tower cron diffs at runtime. Box-side is simplest (mirrors how this audit was just run by hand). Reuse the same parse+diff logic.
- **Surface:** on drift, record a Control Tower incident — a `loop_alert` / `error_events` row ("migration drift: table `X` from `<migration>` is missing") visible on `/dashboard/developer/control-tower`, and register the check as a monitored loop (so a *dead* check is itself visible, per the registry discipline).
- **Scope the noise:** ignore tables a later migration intentionally `drop`s (a `drop table` migration after the create), and tables created conditionally. Only a genuinely-expected-but-absent table alerts. Known-sunset systems can be allowlisted (e.g. don't alert on Klaviyo tables being retired).

## Verification
- With the schema in sync → the check is green (0 missing), and it's registered as a monitored loop (a stale/never-run check shows red, like any other loop).
- Drop a test table that a migration creates (or point at a DB missing one) → the check flags `migration drift: <table> missing (<migration>)` as a Control Tower incident within its window.
- A migration that `create`s then a later one `drop`s a table → NOT flagged (net-absent is correct).
- An allowlisted sunset table (Klaviyo) missing → NOT flagged.
- Negative: a table that exists but has no migration (created ad-hoc) → not a *drift* alarm (out of scope; the check is one-directional: migrations → schema).

## Phase 1 — parse migrations, diff live schema, alert on missing ⏳
Implement the parse+diff (reuse today's audit logic), run it periodically where files+DB coexist (box job or build-manifest), record drift to the Control Tower feed, register it as a monitored loop, with the drop-aware + allowlist scoping. Brain: [[../libraries/control-tower]] · [[control-tower]] · [[error-feed-monitoring]].
