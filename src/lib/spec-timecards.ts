/**
 * spec-timecards — Mario's M1 SDK for the per-lifecycle-step ledger backing
 * `public.spec_timecard_events` ([[../../docs/brain/tables/spec_timecard_events]] ·
 * [[../../docs/brain/specs/spec-timecard-ledger-and-sdk]] ·
 * [[../../docs/brain/goals/mario-pipeline-plumbing]]).
 *
 * Three exports:
 *   - `recordTimecardEvent` — the ONLY writer. A single insert; best-effort try/catch that
 *     logs but never throws so a write error never blocks the lifecycle chokepoint that
 *     called it (Vale review, Sol first-touch, box worker status transitions, fold, spec-test).
 *   - `getTimecard` — per-spec timeline reader for the M5 detail-page timeline. Orders events
 *     by `at` asc, folds paired `wait_entered` / `wait_exited` into wait spans, computes
 *     per-step `gap_ms` (delta from the previous event) and `total_elapsed_ms` (first event to
 *     the terminal marker or now).
 *   - `listStalledCandidates` — the M3 detector cron's scan. Returns rows whose last event
 *     is older than `older_than_ms`.
 *
 * All writes route through the service-role client (per CLAUDE.md's "All writes go through
 * `createAdminClient()`"). Readers accept whatever SupabaseClient the caller passes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

/**
 * The lifecycle-event vocabulary the SDK owns. Free-text on the DB row (no CHECK), so a NEW
 * kind lands without a migration — just extend this union + the callers. Grouped by domain:
 *   - Spec lifecycle: `created`, review pass/fail, `folded`
 *   - Phase lifecycle (each carries `phase_index`): build start/done, ship, spec-test, security
 *   - Job lifecycle (a build/fold/spec-test agent_jobs row transitioning)
 *   - Waits (paired — a `wait_entered` always closes with a `wait_exited`)
 *   - Fold
 */
export type TimecardEventKind =
  | "created"
  | "review_started"
  | "review_passed"
  | "review_failed"
  | "folded"
  | "build_started"
  | "build_done"
  | "phase_shipped"
  | "spec_test_started"
  | "spec_test_verdict"
  | "security_verdict"
  | "job_queued"
  | "job_claimed"
  | "job_completed"
  | "job_failed"
  | "wait_entered"
  | "wait_exited"
  | "fold_started"
  | "fold_done";

/** Which wait a `wait_entered` / `wait_exited` opened. Mirrors the [[agent_jobs]] pause statuses. */
export type TimecardWaitKind =
  | "needs_input"
  | "needs_approval"
  | "blocked_on_dependency"
  | "blocked_on_usage";

/**
 * The `public.spec_timecard_events` row shape — matches the migration
 * `20261001120000_spec_timecard_events.sql` column-for-column.
 */
export interface TimecardEvent {
  id: string;
  workspace_id: string;
  spec_slug: string;
  phase_index: number | null;
  event_kind: string;
  actor: string;
  wait_kind: TimecardWaitKind | string | null;
  waiting_on: string | null;
  at: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * One step in the folded per-spec timeline. `gap_ms` is the delta from the previous step's `at`
 * (null on the first step). `duration_ms` is the length of a folded wait span (null on a
 * point-in-time step); a `wait_entered` that has not closed yet does NOT appear as a step —
 * it surfaces as an open wait on {@link TimecardView.open_waits} instead.
 */
export interface TimecardStep {
  event_kind: string;
  phase_index: number | null;
  actor: string;
  at: string;
  duration_ms: number | null;
  gap_ms: number | null;
  metadata: Record<string, unknown>;
}

/** An unclosed `wait_entered` at the end of the timeline — the spec is still waiting. */
export interface TimecardOpenWait {
  wait_kind: TimecardWaitKind | string;
  waiting_on: string | null;
  entered_at: string;
  gap_ms: number;
}

/**
 * The per-spec timeline view backing the M5 detail-page. Steps are ordered by `at` asc; open
 * waits are the unclosed `wait_entered` events. `total_elapsed_ms` runs from the first event
 * to the terminal marker (a `folded` or `phase_shipped` event, whichever is chronologically
 * latest) or to `now()` when no terminal exists. `first_event_at` anchors the M5 RunningTimer
 * (a live-ticking client island) — null when the spec has no ledger rows yet. `terminal_at`
 * is populated when a terminal marker (`folded` / `phase_shipped`) has landed, so the M5
 * TotalElapsed subcomponent knows to freeze at `total_elapsed_ms` instead of ticking live.
 */
export interface TimecardView {
  spec_slug: string;
  steps: TimecardStep[];
  open_waits: TimecardOpenWait[];
  total_elapsed_ms: number;
  first_event_at: string | null;
  terminal_at: string | null;
}

/** A stalled spec surfaced by {@link listStalledCandidates}. */
export interface StalledCandidate {
  workspace_id: string;
  spec_slug: string;
  last_event_kind: string;
  last_event_at: string;
  gap_ms: number;
}

const SELECT_COLS =
  "id, workspace_id, spec_slug, phase_index, event_kind, actor, wait_kind, waiting_on, at, metadata, created_at";

const TERMINAL_KINDS: ReadonlySet<string> = new Set(["folded", "phase_shipped"]);

/**
 * Append one lifecycle event to the ledger. The only writer; every lifecycle chokepoint routes
 * here. Best-effort: an insert error is logged and swallowed so a temporary DB blip never blocks
 * the caller's real work (Vale's review verdict, Sol's Direction write, the worker's status
 * transition). This is the spec's explicit invariant — "a write error must never block the
 * chokepoint" — because the ledger is a supervisable-autonomy audit trail, not a critical-path
 * write.
 */
export async function recordTimecardEvent(
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
): Promise<void> {
  try {
    const row: Record<string, unknown> = {
      workspace_id: input.workspace_id,
      spec_slug: input.spec_slug,
      event_kind: input.event_kind,
      actor: input.actor,
    };
    if (input.phase_index !== undefined && input.phase_index !== null) row.phase_index = input.phase_index;
    if (input.wait_kind !== undefined && input.wait_kind !== null) row.wait_kind = input.wait_kind;
    if (input.waiting_on !== undefined && input.waiting_on !== null) row.waiting_on = input.waiting_on;
    if (input.metadata !== undefined) row.metadata = input.metadata;
    if (input.at !== undefined) row.at = input.at;
    const { error } = await admin.from("spec_timecard_events").insert(row);
    if (error) {
      console.warn(
        `[spec-timecards] recordTimecardEvent insert failed spec=${input.spec_slug} kind=${input.event_kind}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[spec-timecards] recordTimecardEvent threw spec=${input.spec_slug} kind=${input.event_kind}: ${(e as Error).message}`,
    );
  }
}

/**
 * Fold the raw event stream for one spec into the M5-timeline view. Waits are paired
 * ({@link TimecardWaitKind}-matched) into closed spans with `duration_ms`; unclosed waits
 * surface on `open_waits`. Every step carries `gap_ms` — the delta from the previous step —
 * so the timeline reads as "elapsed since prior step" without the caller re-computing.
 *
 * A wait_entered / wait_exited PAIR is emitted as a SINGLE step (kind='wait_exited',
 * duration_ms = span). The wait_entered on its own is not a step — it's an open-wait signal
 * until closed. This matches the M5 timeline's mental model: "the spec waited N ms on X"
 * is one row, not two.
 */
export async function getTimecard(
  supabase: Admin,
  workspace_id: string,
  spec_slug: string,
): Promise<TimecardView> {
  const { data, error } = await supabase
    .from("spec_timecard_events")
    .select(SELECT_COLS)
    .eq("workspace_id", workspace_id)
    .eq("spec_slug", spec_slug)
    .order("at", { ascending: true });
  if (error) throw error;
  const events = (data ?? []) as TimecardEvent[];
  return foldTimeline(spec_slug, events);
}

/**
 * Pure timeline folder — separated from {@link getTimecard} so unit tests can drive it
 * without a DB. Given a chronologically-sorted event list for ONE spec, returns the
 * TimecardView. Callers should not depend on this signature directly; it's exported for
 * the unit tests the spec's Phase-2 Verification section names.
 */
export function foldTimeline(spec_slug: string, events: TimecardEvent[]): TimecardView {
  const steps: TimecardStep[] = [];
  const open_waits: TimecardOpenWait[] = [];
  // Stack of open waits, keyed by wait_kind; a wait_exited closes the most-recent-matching entry.
  const openStack: Array<{
    wait_kind: TimecardWaitKind | string;
    waiting_on: string | null;
    entered_at: string;
    entered_metadata: Record<string, unknown>;
  }> = [];

  let firstAt: string | null = null;
  let terminalAt: string | null = null;
  let prevStepAt: string | null = null;

  for (const ev of events) {
    if (firstAt === null) firstAt = ev.at;
    if (TERMINAL_KINDS.has(ev.event_kind)) terminalAt = ev.at;

    if (ev.event_kind === "wait_entered") {
      openStack.push({
        wait_kind: (ev.wait_kind as string | null) ?? "unknown",
        waiting_on: ev.waiting_on,
        entered_at: ev.at,
        entered_metadata: ev.metadata ?? {},
      });
      // wait_entered is NOT a step — it's a marker awaiting its exit.
      continue;
    }

    if (ev.event_kind === "wait_exited") {
      // Close the most-recent matching wait on the stack (matched by wait_kind).
      const kindKey = (ev.wait_kind as string | null) ?? "unknown";
      let matched: (typeof openStack)[number] | null = null;
      for (let i = openStack.length - 1; i >= 0; i--) {
        if (openStack[i]!.wait_kind === kindKey) {
          matched = openStack[i]!;
          openStack.splice(i, 1);
          break;
        }
      }
      if (matched) {
        const duration_ms = Date.parse(ev.at) - Date.parse(matched.entered_at);
        const gap_ms = prevStepAt ? Date.parse(matched.entered_at) - Date.parse(prevStepAt) : null;
        steps.push({
          event_kind: "wait_exited",
          phase_index: ev.phase_index,
          actor: ev.actor,
          at: ev.at,
          duration_ms,
          gap_ms,
          metadata: { ...matched.entered_metadata, ...(ev.metadata ?? {}) },
        });
        prevStepAt = ev.at;
        continue;
      }
      // No matching wait_entered — emit the wait_exited as an orphan point-in-time step.
    }

    const gap_ms = prevStepAt ? Date.parse(ev.at) - Date.parse(prevStepAt) : null;
    steps.push({
      event_kind: ev.event_kind,
      phase_index: ev.phase_index,
      actor: ev.actor,
      at: ev.at,
      duration_ms: null,
      gap_ms,
      metadata: ev.metadata ?? {},
    });
    prevStepAt = ev.at;
  }

  // Any wait still open at the end surfaces as an open_wait.
  for (const w of openStack) {
    open_waits.push({
      wait_kind: w.wait_kind,
      waiting_on: w.waiting_on,
      entered_at: w.entered_at,
      gap_ms: Date.now() - Date.parse(w.entered_at),
    });
  }

  const endAt = terminalAt ? Date.parse(terminalAt) : Date.now();
  const total_elapsed_ms = firstAt ? Math.max(0, endAt - Date.parse(firstAt)) : 0;

  return {
    spec_slug,
    steps,
    open_waits,
    total_elapsed_ms,
    first_event_at: firstAt,
    terminal_at: terminalAt,
  };
}

/**
 * The M3 stall-detector's per-tick scan. Returns every spec whose last ledger event is older
 * than `older_than_ms` — the caller (the detector cron) passes its per-step SLA. Optionally
 * scoped to one workspace so a per-tenant sweep doesn't drag every workspace's ledger.
 *
 * Implementation: fetch events for the (optionally) scoped workspace ordered by `at` desc,
 * group by `(workspace_id, spec_slug)` in memory, keep the most recent per group, filter by
 * gap. This is O(events per workspace) — the covering index
 * `spec_timecard_events_lookup_idx (workspace_id, spec_slug, at)` supports the sort. The
 * per-workspace scan is bounded; a global scan (no workspace_id) is intended for the M3
 * fleet-supervisor use.
 *
 * Excludes specs whose most recent event is a terminal marker (`folded` — a folded spec is
 * done, not stalled). This matches the M3 semantic: "step-done to next-step-started beyond
 * SLA" is only meaningful for a spec still in flight.
 */
export async function listStalledCandidates(
  admin: Admin,
  opts: { workspace_id?: string; older_than_ms: number; limit?: number },
): Promise<StalledCandidate[]> {
  const now = Date.now();
  let q = admin
    .from("spec_timecard_events")
    .select("workspace_id, spec_slug, event_kind, at")
    .order("at", { ascending: false });
  if (opts.workspace_id) q = q.eq("workspace_id", opts.workspace_id);
  // A generous cap so the memory-grouping step stays bounded; the caller can raise it if a
  // workspace ever grows past the default. The order-desc + first-per-group logic below is
  // safe under truncation because a truncated tail is by definition older events, which
  // wouldn't overwrite a fresh last-per-group.
  q = q.limit(opts.limit ?? 20_000);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    workspace_id: string;
    spec_slug: string;
    event_kind: string;
    at: string;
  }>;

  const lastBy = new Map<
    string,
    { workspace_id: string; spec_slug: string; event_kind: string; at: string }
  >();
  for (const r of rows) {
    const key = `${r.workspace_id}::${r.spec_slug}`;
    if (!lastBy.has(key)) lastBy.set(key, r);
  }

  const out: StalledCandidate[] = [];
  for (const r of lastBy.values()) {
    if (r.event_kind === "folded") continue;
    const gap_ms = now - Date.parse(r.at);
    if (gap_ms > opts.older_than_ms) {
      out.push({
        workspace_id: r.workspace_id,
        spec_slug: r.spec_slug,
        last_event_kind: r.event_kind,
        last_event_at: r.at,
        gap_ms,
      });
    }
  }
  return out;
}

// ── build-completed-with-deferred-pr-must-auto-redrive-not-silently-stall Phase 2 ────────────────
//
// Close orphaned needs_input wait spans on build resume / completion.
//
// The per-row wait_entered / wait_exited chokepoint (`resolvePendingWaitTransition` in
// [[../../scripts/builder-worker.ts]]) fires ONLY when the SAME agent_jobs row transitions from a
// wait status to `queued_resume`. That misses the multi-open-span case the
// factor-scores-reweight-selection-engine 35-min stall exhibited: two separate `needs_input`
// spans (04:08 + 12:59) opened for the same spec across different job rows, and the resume →
// build-done flow closed neither — so `getTimecard.open_waits` reported waiting:true for a spec
// that was already running work, corrupting the M3 legit-wait filter and any operator read.
//
// This helper reads the spec's ledger, folds it with the SAME stack-pairing logic
// [[foldTimeline]] uses, and emits ONE `wait_exited` per still-open span whose `wait_kind`
// matches `waitKind` (default `needs_input`). Idempotent — a call with nothing to close is a
// no-op; a repeat call finds no open spans and returns 0. The emitted rows carry
// `metadata.superseded_by_build_activity=true` + the `reason` so the audit trail explains why
// the span was closed by the worker rather than by a paired user-side unblock.
export interface CloseOrphanedWaitSpansResult {
  closed: number;
  wait_kinds: string[];
}

export async function closeOrphanedNeedsInputWaitSpans(
  admin: Admin,
  workspace_id: string,
  spec_slug: string,
  opts: {
    actor: string;
    reason: string;
    /** Restrict to one kind (default `needs_input` — the class the spec cites). Pass `null` for ANY wait. */
    wait_kind?: TimecardWaitKind | string | null;
    /** Structured note attached to the emitted `wait_exited` metadata so the audit is self-describing. */
    extra_metadata?: Record<string, unknown>;
  },
): Promise<CloseOrphanedWaitSpansResult> {
  try {
    const { data, error } = await admin
      .from("spec_timecard_events")
      .select(SELECT_COLS)
      .eq("workspace_id", workspace_id)
      .eq("spec_slug", spec_slug)
      .order("at", { ascending: true });
    if (error) {
      console.warn(
        `[spec-timecards] closeOrphanedNeedsInputWaitSpans read failed spec=${spec_slug}: ${error.message}`,
      );
      return { closed: 0, wait_kinds: [] };
    }
    const events = (data ?? []) as TimecardEvent[];
    const view = foldTimeline(spec_slug, events);
    const wanted = opts.wait_kind === undefined ? "needs_input" : opts.wait_kind;
    const orphans = view.open_waits.filter((w) => wanted === null ? true : w.wait_kind === wanted);
    if (orphans.length === 0) return { closed: 0, wait_kinds: [] };
    let closed = 0;
    const kinds: string[] = [];
    for (const w of orphans) {
      // Emit ONE wait_exited per open span. foldTimeline's stack-pairing means the most-recent
      // matching wait_entered pops off first, so repeated emissions here close successive spans
      // in stack order (LIFO). We emit sequentially (not concurrently) so an inbound get-view
      // read never observes a partial state.
      await recordTimecardEvent(admin, {
        workspace_id,
        spec_slug,
        event_kind: "wait_exited",
        actor: opts.actor,
        wait_kind: w.wait_kind,
        metadata: {
          superseded_by_build_activity: true,
          reason: opts.reason,
          entered_at: w.entered_at,
          waiting_on: w.waiting_on,
          ...(opts.extra_metadata ?? {}),
        },
      });
      closed += 1;
      kinds.push(String(w.wait_kind));
    }
    return { closed, wait_kinds: kinds };
  } catch (e) {
    console.warn(
      `[spec-timecards] closeOrphanedNeedsInputWaitSpans threw spec=${spec_slug}: ${(e as Error).message}`,
    );
    return { closed: 0, wait_kinds: [] };
  }
}
