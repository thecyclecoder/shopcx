# inngest/media-buyer-grade

The daily cadence cron + per-workspace sweep that dispatches the [[../libraries/media-buyer-grader]] deterministic grader over concluded Media Buyer actions ([[../specs/media-buyer-grade-daily-cron]] Phase 1 — the missing "grading" piece of the [[../goals/autonomous-media-buyer-supervision]] M4 "Graded + self-correcting" milestone). Once daily it finds every workspace with ≥1 UNGRADED settled Media Buyer [[../tables/director_activity]] row (older than `REALIZED_WINDOW_MIN_DAYS = 3d`), fans out one event per workspace, and the per-workspace handler inserts one [[../tables/agent_jobs]] row `kind='media-buyer-grade'` — the box worker's `runMediaBuyerGradeJob` lane runs [[../libraries/media-buyer-grader]] `gradeMediaBuyerActions` deterministically (no Max session, no LLM).

**File:** `src/lib/inngest/media-buyer-grade.ts` · grader logic in [[../libraries/media-buyer-grader]] (`gradeMediaBuyerActions` invoked by the box worker's `runMediaBuyerGradeJob` lane)

## Functions

### `media-buyer-grade-cron`
- **Trigger:** cron `0 14 * * *` (once daily at 14:00 UTC — 1h after the [[media-buyer-cadence]] cadence pass so any freshly-concluded actions from earlier days are already in the ledger and the sensor rolls have settled)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** reads every `director_activity` row whose `action_kind` is in [[../libraries/media-buyer-grader]] `GRADEABLE_ACTION_KINDS` and whose `created_at` is older than the settled cutoff, cross-checks against [[../tables/media_buyer_action_grades]] via `director_activity_id` so any already-graded row drops out, then fans out one `growth/media-buyer-grade-sweep` event per DISTINCT remaining workspace. A workspace whose newest gradeable action is younger than 3d contributes nothing (the settled-window guard). End-of-run heartbeat via `emitCronHeartbeat("media-buyer-grade-cron", { ok:true, produced:{workspaces}, detail })`.
- **Returns** `{ workspaces }` (count fanned out).

### `media-buyer-grade-sweep`
- **Trigger:** event `growth/media-buyer-grade-sweep` (data: `{ workspace_id, trigger? }`)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`, `retries: 1`
- **What it does:** calls `dispatchMediaBuyerGradeSweep(admin, workspace_id)` inside `step.run` to insert one [[../tables/agent_jobs]] row for the workspace with `kind='media-buyer-grade'`, `spec_slug` set to the stable `mediaBuyerGradeSpecSlug()` value, and `instructions = { limit: 50 }` (matches the [[../libraries/media-buyer-grader]] default). The box worker's `runMediaBuyerGradeJob` lane picks it up and runs [[../libraries/media-buyer-grader]] `gradeMediaBuyerActions(admin, { workspaceId, limit })`.
- **Returns** `{ status: "complete", dispatched }`.

### `MEDIA_BUYER_GRADE_SPEC_SLUG`
- **Constant:** `"media-buyer-grade:workspace"`
- **What it is:** Stable workspace-scoped `agent_jobs.spec_slug` for the Media Buyer grade job. The column is `NOT NULL`, so an omitted value blocks the insert and no grader row lands. One workspace runs one grader pass per cron tick, so a single per-workspace slug is the durable bucket for the `agent_jobs_slug_idx (workspace_id, spec_slug, ...)` Roadmap rollups.

### `mediaBuyerGradeSpecSlug()`
- **Signature:** `function mediaBuyerGradeSpecSlug(): string`
- **What it does:** Returns the stable slug `"media-buyer-grade:workspace"` — helper form parallel to [[./media-buyer-cadence]] `mediaBuyerSpecSlug`.

### `dispatchMediaBuyerGradeSweep(admin, workspaceId)`
- **Signature:** `async function dispatchMediaBuyerGradeSweep(admin: Admin, workspaceId: string): Promise<{ dispatched: number }>`
- **What it does:** Pure per-workspace insert extracted from the Inngest handler — inserts ONE workspace-scoped `agent_jobs` row `kind='media-buyer-grade'` with a stable non-empty `spec_slug` (via `mediaBuyerGradeSpecSlug()`) and `instructions.limit=MEDIA_BUYER_GRADE_DEFAULT_LIMIT` (50). Throws if the insert fails.
- **Returns** `{ dispatched: 1 }` on success.

## Idempotency

The grader is idempotent — the UNIQUE index on `media_buyer_action_grades.director_activity_id` collapses re-runs and `gradeMediaBuyerActions` uses `.select("id")` compare-and-set writes. A same-UTC-day re-fire of the cron simply re-scores rows that landed since the last pass; a workspace with zero ungraded settled rows contributes zero events. Any duplicate `growth/media-buyer-grade-sweep` event enqueues a redundant `kind='media-buyer-grade'` job that no-ops against `{ graded: 0, skipped: 0 }` when the backlog is already scored.

## North-star invariant

The grader is a **supervised grading tool** ([[../operational-rules]] § North star) — it observes and scores; it never mutates the source `director_activity` row and never reverts a Media Buyer action itself. The M4 "self-correcting" revert consumer reads `media_buyer_action_grades` DOWNSTREAM and is a separately-supervised path.

## Shadow-default under the M2 policy

Under the [[../goals/autonomous-media-buyer-supervision]] M2 "Shadow mode (read-only)" milestone, the concluded Media Buyer actions in [[../tables/director_activity]] are still SHADOW proposals (no real Meta writes) — the grader scores them the same way against the active policy's thresholds regardless, so the M4 rollup + revert consumers ingest a grade stream well before the workspace flips the policy live.

## Downstream events sent

- `growth/media-buyer-grade-sweep` (one per workspace with ≥1 ungraded settled action, from the cron's fan-out)

Downstream side effect from the sweep is a `kind='media-buyer-grade'` [[../tables/agent_jobs]] insert per fan-out. The box worker's `runMediaBuyerGradeJob` lane picks it up and runs [[../libraries/media-buyer-grader]] `gradeMediaBuyerActions`, which UPSERTs one row per action into [[../tables/media_buyer_action_grades]] keyed on `director_activity_id`.

## Tables written

- [[../tables/agent_jobs]] (one `kind='media-buyer-grade'` row per sweep — `instructions = { limit: 50 }`)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/director_activity]] (ungraded settled action discovery — filtered by `action_kind` ∈ [[../libraries/media-buyer-grader]] `GRADEABLE_ACTION_KINDS` and `created_at < now - 3d`)
- [[../tables/media_buyer_action_grades]] (`director_activity_id` cross-check — a row already scored drops out of the fan-out)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth` (`livenessWindowMs` 26h, `registeredAt: 2026-07-09T14:00:00Z` for the newcron-grace) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Known fixes

**The `spec_slug` NOT NULL boundary (2026-07-14 outage):** The `mediaBuyerGradeSweep` handler now calls the extracted `dispatchMediaBuyerGradeSweep` helper, which always supplies the stable `mediaBuyerGradeSpecSlug()` value when inserting into `agent_jobs`. The `spec_slug` column is `NOT NULL` in the migrations — an omitted value throws `null value in column "spec_slug" of relation "agent_jobs" violates not-null constraint` and no grader row lands. The scope of the guard: the `mediaBuyerGradeSweep` event handler is the sole caller of `dispatchMediaBuyerGradeSweep`, so this guard path protects the entire grader-enqueue flow. A focused regression test (media-buyer-grade.test.ts) simulates the exact constraint error and validates that all three required fields (`spec_slug`, `kind`, `instructions.limit`) land correctly.

## Related

[[../libraries/media-buyer-grader]] · [[../libraries/media-buyer-agent]] · [[../tables/director_activity]] · [[../tables/media_buyer_action_grades]] · [[../tables/meta_attribution_daily]] · [[../tables/agent_jobs]] · [[media-buyer-cadence]] · [[growth-ad-spend-governor]] · [[../specs/media-buyer-grade-daily-cron]] · [[../specs/media-buyer-daily-cadence-cron]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]]
