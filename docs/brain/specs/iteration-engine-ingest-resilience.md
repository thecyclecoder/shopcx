# Iteration Engine Ingest Resilience ⏳

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Storefront CRO"

Summary: The Storefront Iteration Engine's daily run ([[../inngest/meta-performance]] `meta-iteration-run`) dies at stage 1 (ingest) on Meta's transient `meta_400: Service temporarily unavailable` (Graph error code 2) — confirmed in production on 2026-06-21 for account `d6d619a5-3a8d-47d7-baea-a7170b783ad0` (`Stage reached: 0`). The token resolved fine (not a credential/account problem); the failure is the **first-run 90-day, day-incremented, ad-level insights pull** being too heavy for Meta to serve synchronously, made **fatal and self-perpetuating** because the Graph client ([[../libraries/meta__performance]] `graphGet`) has no retry/backoff and the backfill never lands a row to flip itself off — so every subsequent daily run re-attempts the same heavy backfill and fails identically, and DMs the owners each time. This spec makes ingestion resilient (retry transient Meta errors) and self-healing (chunk the backfill so requests stay light and partial progress disables the first-run path). Business outcome: the engine actually runs daily and produces the scorecards/decisions paid-social optimization depends on, instead of failing silently-to-Slack every morning.

## Phase 1 — Transient-error retry/backoff in the Graph client ⏳
Goal: a routine Meta wobble no longer fails the whole daily run.
- ⏳ In `graphGet` (`src/lib/meta/performance.ts`) and the sibling `metaGet`/`metaPost` (`src/lib/meta-ads.ts`), stop discarding Meta's error detail — capture `error.code`, `error.error_subcode`, and `error.is_transient` from the Graph JSON (today only `error.message` survives).
- ⏳ Classify transient vs fatal: retry when `error.is_transient === true`, `error.code === 2` ("Service temporarily unavailable"), `error.code === 1` ("unknown, retry later"), HTTP `429`, or HTTP `5xx`. Do **not** retry fatal errors (`190` invalid/expired token, `200`/`10`/`803` permissions, `400` validation) — those still fail fast so a real misconfiguration surfaces immediately.
- ⏳ Bounded exponential backoff with jitter (e.g. 3–4 attempts, base ~1s, capped) before giving up; a real outage still throws after attempts are exhausted (the run records `failed` + DMs owners exactly as today — resilience, not silent swallowing).
- ⏳ Surface the decision: on a transient retry, `console.warn` the code/subcode/attempt so the behavior is legible in logs (matches the engine's "supervisable, not silent" invariant).

## Phase 2 — Chunked, resumable backfill ⏳
Goal: the first-run 90-day pull never trips code 2, and the engine self-heals without a manual re-trigger.
- ⏳ In `syncMetaInsightsForLevel` / `syncMetaInsights` (`src/lib/meta/performance.ts`), slice the requested `[startDate, endDate]` into small sub-windows (≤14 days) and pull each sub-window per level, rather than one synchronous request spanning the whole range. Day-incremented ad-level insights over a short window is light enough for Meta to serve.
- ⏳ Upsert each sub-window's rows as it lands (the existing idempotent upsert on `(workspace_id, meta_object_id, level, snapshot_date)` is preserved) so partial progress is durable — a failure mid-backfill keeps the slices already written.
- ⏳ Self-healing first-run flag: because `ingestMetaPerformance` derives `backfilled = !count` from `meta_insights_daily`, once the early slices write rows the next run's window collapses to the light 3-day incremental path automatically — no human re-trigger needed to recover.
- ⏳ Order slices newest-first so the most recent (decision-relevant) days land before older history if the backfill is interrupted.

## Phase 3 — Asynchronous insights for large pulls ⏳ (deferred)
Goal: use Meta's sanctioned path for long date ranges; not required to fix the 2026-06-21 failure (Phases 1–2 do that).
- ⏳ For the first-run backfill window, submit an **async insights report** (`POST /act_{id}/insights` → `report_run_id`, poll `GET /{report_run_id}` until `job_status='Job Completed'`, then page results) instead of synchronous GET; keep synchronous GET for the small daily incremental window.
- ⏳ Gate behind a flag so it ships independently of Phases 1–2 and can be enabled per account.

## Safety / invariants
- **No change to any write path.** This spec only hardens the READ/ingest path (`graphGet` + insights pulls). All DB writes remain the existing idempotent upserts; all Meta *writes* (pause/scale/draft) are untouched and still bounded by the active policy + approved-build flow.
- **Retries are bounded.** Transient retries have a hard attempt cap; a genuine Meta outage still fails the run loudly (`iteration_runs.status='failed'` + `notify-ops-alert` DM) after attempts are exhausted — failures are surfaced, never silently swallowed.
- **Fatal errors still fail fast.** Invalid/expired token and permission errors are not retried, so a real misconfiguration is not masked by backoff.
- **Idempotent re-runs.** Chunked/partial backfills and retries never double-write — every insight upsert keys on `(workspace_id, meta_object_id, level, snapshot_date)`; a same-day re-run is stable.
- **Legible behavior.** Transient retries and backoff are logged (code/subcode/attempt), consistent with the engine's "supervisable, not silent" north star.

## Completion criteria
- A transient Meta error (`is_transient` / code 2 / 429 / 5xx) during ingest is retried with backoff and the run survives instead of failing at stage 1.
- The first-run 90-day backfill for account `d6d619a5-3a8d-47d7-baea-a7170b783ad0` completes without a `meta_400: Service temporarily unavailable`, landing `meta_insights_daily` rows across all three levels.
- After the first successful (possibly partial) backfill, subsequent daily runs use the light incremental window automatically (no manual re-trigger).
- A genuine, sustained Meta outage still produces a `failed` `iteration_runs` row + owner DM after the retry budget is exhausted (resilience did not become silent failure).
- Re-running the same `meta/iteration-run` produces no duplicate `meta_insights_daily` rows.

## Verification
- Apply nothing schema-wise (code-only change). Confirm `npx tsc --noEmit` is clean before shipping.
- **Transient retry survives:** temporarily force `graphGet` to see a simulated transient (code 2 / HTTP 503) on the first attempt (e.g. a test hook or a one-off harness), then send `meta/iteration-run` for the account → the ingest stage logs a retry `console.warn` with the code/attempt and the run completes `status='complete'` (the latest `iteration_runs` row), not `failed`.
- **Fatal still fails fast:** with an invalid token (code 190), send `meta/iteration-run` → the run fails at stage 1 with no retry storm (a single fast failure, `iteration_runs.status='failed'`, owner DM fired) — confirming fatal errors are not retried.
- **First-run backfill in chunks:** for an account with `meta_insights_daily` empty, send `meta/iteration-run` (manual) → it completes without `meta_400: Service temporarily unavailable`; `select level, count(*) from meta_insights_daily where meta_ad_account_id='d6d619a5-3a8d-47d7-baea-a7170b783ad0';` → rows at `campaign`/`adset`/`ad`. Inspect logs/network to confirm the backfill issued multiple ≤14-day sub-window requests, not one 90-day request.
- **Self-heals to incremental:** after the backfill lands rows, send `meta/iteration-run` again → the ingest window is the 3-day incremental path (no 90-day re-pull), visible in the run's `ingest` stage and timing.
- **Idempotency:** re-send the same `meta/iteration-run` → `select count(*) from meta_insights_daily where meta_ad_account_id='<id>';` is stable across runs (no duplicate `(workspace_id, meta_object_id, level, snapshot_date)` rows).
- **Outage still alerts:** force every attempt to return code 2 (sustained) → after the retry budget the latest `iteration_runs` row is `status='failed'` with the transient error string, and workspace owners/admins receive the `notify-ops-alert` "Iteration engine daily run failed" DM.
