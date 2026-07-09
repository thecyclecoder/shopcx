# libraries/spec-timecards

Server SDK for the per-lifecycle-step ledger — Mario's M1 foundation ([[../tables/spec_timecard_events]] · [[../specs/spec-timecard-ledger-and-sdk]] · [[../goals/mario-pipeline-plumbing]]). The only writer for [[../tables/spec_timecard_events]]; two readers back the M3 stall-detector cron and the M5 spec-detail-page timeline. All writes route through a service-role client the caller passes in (`createAdminClient()` in the worker — per CLAUDE.md's "All writes go through `createAdminClient()`").

**File:** `src/lib/spec-timecards.ts`

## Why this exists

Every ShopCX spec moves through a fixed lifecycle — `created` → review → build phase(s) → ship → spec-test → security → fold — punctuated by unbounded waits (`needs_input`, `needs_approval`, `blocked_on_dependency`, `blocked_on_usage`). Before Mario there was no single ledger of that history — the trail was scattered across [[../tables/spec_status_history]], [[../tables/agent_jobs]] `updated_at`, [[../tables/spec_test_runs]], [[../libraries/director-activity|director_activity]], and merge SHAs on [[../tables/spec_phases]]. That meant the median stall (step-done to next-step-started beyond SLA) couldn't be detected in under a full SLA window — the reader had to reconstruct the timeline every time.

`spec-timecards.ts` fixes that by giving every lifecycle chokepoint (Vale, the box worker's status transitions, Sol's first-touch, fold, spec-test) ONE sanctioned append via {@link recordTimecardEvent}, and giving Mario's M3 detector + the M5 detail page ONE sanctioned read via {@link getTimecard} + {@link listStalledCandidates}. The ledger is supervisable-autonomy overhead — a write error must never block the chokepoint, so every write is a best-effort try/catch that logs and returns.

## Types

- `TimecardEventKind` — enumerated string union of the lifecycle vocabulary: `created` ｜ `review_started` ｜ `review_passed` ｜ `review_failed` ｜ `folded` ｜ `build_started` ｜ `build_done` ｜ `phase_shipped` ｜ `spec_test_started` ｜ `spec_test_verdict` ｜ `security_verdict` ｜ `job_queued` ｜ `job_claimed` ｜ `job_completed` ｜ `job_failed` ｜ `wait_entered` ｜ `wait_exited` ｜ `fold_started` ｜ `fold_done`. The DB column is free text (no CHECK) so a new kind lands without a migration — just extend this union + the caller.
- `TimecardWaitKind = 'needs_input' | 'needs_approval' | 'blocked_on_dependency' | 'blocked_on_usage'` — the four wait dispositions a `wait_entered` / `wait_exited` pair carries. Mirrors the [[../tables/agent_jobs]] `status` values that pause a build.
- `TimecardEvent` — the raw row shape (mirrors `20261001120000_spec_timecard_events.sql` column-for-column).
- `TimecardStep` — one folded timeline step: `{ event_kind, phase_index, actor, at, duration_ms | null, gap_ms | null, metadata }`. `duration_ms` is non-null only on a closed wait span; `gap_ms` is the delta from the previous step's `at` (null on the first step).
- `TimecardOpenWait` — an unclosed `wait_entered` at the end of the timeline: `{ wait_kind, waiting_on, entered_at, gap_ms }`. Surfaces the spec's live "what is this spec waiting on right now" signal.
- `TimecardView` — the M5 detail-page shape: `{ spec_slug, steps, open_waits, total_elapsed_ms }`. `total_elapsed_ms` runs from the first event to the terminal marker (a `folded` or `phase_shipped`, whichever is chronologically latest) or to `now()` when none exists.
- `StalledCandidate` — one row of {@link listStalledCandidates}: `{ workspace_id, spec_slug, last_event_kind, last_event_at, gap_ms }`.

## Exports

### `recordTimecardEvent` — function

```ts
async function recordTimecardEvent(
  admin: Admin,
  input: {
    workspace_id: string;
    spec_slug: string;
    phase_index?: number | null;
    event_kind: TimecardEventKind | string;
    actor: string;
    wait_kind?: TimecardWaitKind | string | null;
    waiting_on?: string | null;
    metadata?: Record<string, unknown>;
    at?: string;
  },
): Promise<void>
```

Append ONE lifecycle event to [[../tables/spec_timecard_events]]. **Best-effort — never throws.** An insert error is logged (`console.warn`) and swallowed so a temporary DB blip never blocks the chokepoint that called it. This is deliberate: the ledger is an audit trail Mario reads later; a write failure must not fail a Vale verdict, a Sol Direction write, or a build-worker status transition. The write is a single service-role `.insert()`; no compare-and-set (append-only, no invariant to guard).

**Called by:** (M2 wiring — this Phase-2 SDK ships with no in-tree callers). The M2 spec (`mario-lifecycle-chokepoint-wiring`) will point Vale's review verdict, the box worker's `update()` chokepoint, Sol's `writeDirection`, the fold path, and the spec-test verdict at this function.

### `getTimecard` — function

```ts
async function getTimecard(
  supabase: Admin,
  workspace_id: string,
  spec_slug: string,
): Promise<TimecardView>
```

Read every event for one spec (ordered `at` asc), fold paired `wait_entered` / `wait_exited` events into closed wait spans (single step of kind `wait_exited`, `duration_ms = span`), surface unclosed waits on `open_waits`, and compute `gap_ms` per step (delta from the previous step's `at`). `total_elapsed_ms` runs from the first event to the terminal marker (max of `folded`/`phase_shipped`.at) or to `now()` when no terminal exists. Uses the covering index `spec_timecard_events_lookup_idx (workspace_id, spec_slug, at)`.

**Called by:** the M5 spec-detail-page timeline (not yet wired — that's a future spec).

### `foldTimeline` — function

```ts
function foldTimeline(spec_slug: string, events: TimecardEvent[]): TimecardView
```

Pure timeline folder, exported for unit tests the Phase-2 Verification bullets exercise (a `wait_entered` + `wait_exited` three seconds later → exactly one closed span with `duration_ms ≈ 3000` and no open_waits). Callers should prefer {@link getTimecard} — this is exported so tests can drive the fold logic without a DB round-trip.

### `listStalledCandidates` — function

```ts
async function listStalledCandidates(
  admin: Admin,
  opts: { workspace_id?: string; older_than_ms: number; limit?: number },
): Promise<StalledCandidate[]>
```

The M3 stall-detector cron's scan. Fetches events for the (optionally) scoped workspace ordered by `at` desc, groups by `(workspace_id, spec_slug)` in memory, keeps the most recent per group, and returns rows whose gap-from-now exceeds `older_than_ms`. Excludes specs whose most recent event is `folded` — a folded spec is done, not stalled. `limit` bounds the fetch (default 20 000) so a runaway workspace's ledger doesn't fan out; the tail is by definition older events which wouldn't overwrite a fresh last-per-group.

**Called by:** the M3 detector cron (not yet wired — that's the M3 spec).

## Invariants

- **Best-effort writes.** `recordTimecardEvent` never throws. A DB error logs + returns. The ledger is an audit trail, not a critical-path write — a write failure must not break the caller's lifecycle transition.
- **Append-only.** No export mutates or deletes an existing row. Re-authoring history requires a new event (`corrected`, once the vocabulary needs it) — never an in-place UPDATE. The DB has no update policy for authenticated users; the service-role writer is the only mutator, and this SDK never calls UPDATE.
- **Wait pairs.** A `wait_entered` opens a span; a `wait_exited` with the same `wait_kind` closes it. `getTimecard` folds a matched pair into one closed step (kind `wait_exited`, `duration_ms = span`); an unmatched `wait_entered` surfaces on `open_waits`. Waiters that never close remain OPEN — the M5 timeline reads "spec waiting on X for Y ms" from the open_waits array.
- **Service-role only.** Every export takes `admin: SupabaseClient` — RLS is on with a workspace-members `select` policy + a service-role all policy, so a non-service-role write is rejected at the DB. Never call {@link recordTimecardEvent} from client code.
- **Ledger terminates at `folded`.** `total_elapsed_ms` stops climbing once a `folded` event lands; a `phase_shipped` also anchors the terminal for a single-phase spec that hasn't been folded yet. Everything else is "still in flight" and `total_elapsed_ms` uses `now()`.

## Callers

- **Spec-detail page** — [[../dashboard/roadmap]] · `src/app/dashboard/roadmap/[slug]/page.tsx`
  calls `getTimecard(admin, workspace_id, slug)` inside its per-workspace `Promise.all` and
  passes the returned `TimecardView` (steps, open_waits, total_elapsed_ms, first_event_at,
  terminal_at) to `LifecycleTimeline`. The timeline paints per-stage duration labels,
  inter-stage gap pills colored by `mario_thresholds` SLA (zinc / amber / rose), a
  `WaitRow` per entry in `open_waits` (color: sky / amber / rose), and a top "Elapsed:" /
  "Total:" badge driven by `first_event_at` / `terminal_at`. See
  [[../specs/spec-detail-timecard-timeline]] Phase 4 (Fix 1).
- Mario M2 (`mario-lifecycle-chokepoint-wiring`) points every lifecycle chokepoint at
  {@link recordTimecardEvent}. Mario M3 (`mario-stall-detector-cron`) reads
  {@link listStalledCandidates}.

## Related

[[../tables/spec_timecard_events]] · [[../specs/spec-timecard-ledger-and-sdk]] · [[../goals/mario-pipeline-plumbing]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../tables/spec_status_history]] · [[../tables/spec_test_runs]] · [[../tables/agent_jobs]] · [[../../CLAUDE]]
