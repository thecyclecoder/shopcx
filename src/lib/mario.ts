/**
 * mario — Mario's M3 SDK (detector cron's core). One deterministic call —
 * `evaluateStalledSpecs` — turns the M1 [[spec_timecard_events]] ledger + the M2
 * wait-span vocabulary + every spec's uncleared blockedBy into "is THIS spec
 * genuinely stalled?" candidates, and `enqueueMarioJob` files a kind='mario'
 * [[agent_jobs]] row (dedupe-guarded) so exactly one live mario job exists per
 * spec_slug at a time.
 *
 * Owns THE legit-wait discriminator: a spec is a STALL only when NOTHING is
 * blocking it — no uncleared blocker, no in-flight wait status on its active
 * job, and it isn't a folded row that stopped emitting events on purpose. Every
 * "drop" below is a legit wait, not a stall.
 *
 * Reads:
 *   - [[../../docs/brain/tables/mario_thresholds]] via the workspace-scoped SELECT —
 *     one `sla_ms` per (from_event, to_event) pair. The M4 self-tuner is the sole
 *     writer of `sla_ms`.
 *   - [[../../docs/brain/tables/spec_timecard_events]] via
 *     [[./spec-timecards]] `listStalledCandidates` per-threshold-row.
 *   - Each candidate's [[./brain-roadmap]] `getSpecBlockers` (uncleared → drop) +
 *     spec status (folded → drop).
 *   - The candidate's current active [[agent_jobs]] row (wait status → drop).
 *
 * Writes:
 *   - `enqueueMarioJob` INSERTs one row into [[agent_jobs]] (kind='mario') gated on
 *     "no active mario row for this spec_slug already exists".
 *
 * The cron in [[./inngest/mario-stall-cron]] wires these into the once-per-minute tick.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { listStalledCandidates } from "@/lib/spec-timecards";
import { getSpecBlockers } from "@/lib/brain-roadmap";
import { getSpec as getSpecFromDb } from "@/lib/specs-table";
import { ACTIVE_STATUSES } from "@/lib/agent-jobs";

type Admin = SupabaseClient;

/**
 * The threshold row shape — one per (workspace_id, from_event, to_event) in
 * [[../../docs/brain/tables/mario_thresholds]]. The evaluator reads every row for a
 * workspace and turns each into an `older_than_ms` input to `listStalledCandidates`.
 */
export interface MarioThreshold {
  workspace_id: string;
  from_event: string;
  to_event: string;
  sla_ms: number;
  min_count: number;
}

/**
 * The brief attached to every StalledCandidate — the payload the M4 reasoning
 * agent picks up off `agent_jobs.instructions` so it can reason WITHOUT
 * re-reading the ledger. Bounded (last 10 events).
 */
export interface MarioBrief {
  /** the last 10 [[spec_timecard_events]] rows for this spec, newest-first */
  last_events: Array<{
    event_kind: string;
    phase_index: number | null;
    actor: string;
    at: string;
    wait_kind: string | null;
    waiting_on: string | null;
  }>;
  /** every entry from [[./brain-roadmap]] `getSpecBlockers` — used by M4 to explain
   *  why THIS spec is a stall (every blocker cleared) rather than a legit wait */
  blocked_by_state: Array<{ slug: string; cleared: boolean }>;
  /** the current active [[agent_jobs]] row's status (or `null` when the spec has no
   *  live job) — set to a wait status only when M4 is about to look at a candidate
   *  that just transitioned; the evaluator's own filter would drop a wait status */
  current_job_status: string | null;
}

/**
 * One stalled spec surfaced by `evaluateStalledSpecs`. Carries which
 * (from_event, to_event) pair was overshot, the actual gap, the SLA it broke,
 * and the full MarioBrief so the M4 reasoning agent picks it up off
 * `agent_jobs.instructions` without another read.
 */
export interface StalledCandidate {
  workspace_id: string;
  spec_slug: string;
  from_event: string;
  to_event: string;
  gap_ms: number;
  sla_ms: number;
  brief: MarioBrief;
}

/**
 * The [[agent_jobs]] statuses that mean "there is already a live mario job on
 * this spec — do not enqueue another". Mirrors {@link ACTIVE_STATUSES} but is
 * inlined as a Set for the SELECT filter — the SDK owns Mario's dedupe
 * definition explicitly (a widened status set would silently skip stalls).
 */
export const ACTIVE_MARIO_STATUSES: ReadonlySet<string> = new Set(ACTIVE_STATUSES);

const BRIEF_EVENT_LIMIT = 10;

/** Re-fire cooldown (see the guard in `enqueueMarioJob`): Mario looks at a still-stalled spec at most once
 *  per hour, so an escalate / didn't-take fix can't spin the cron into a per-minute Max-session burn. */
const MARIO_REFIRE_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Read every (from_event, to_event) threshold row for a workspace. The evaluator
 * makes one `listStalledCandidates` scan per row.
 */
async function readThresholds(admin: Admin, workspace_id?: string): Promise<MarioThreshold[]> {
  let q = admin
    .from("mario_thresholds")
    .select("workspace_id, from_event, to_event, sla_ms, min_count")
    .order("from_event", { ascending: true })
    .order("to_event", { ascending: true });
  if (workspace_id) q = q.eq("workspace_id", workspace_id);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    workspace_id: string;
    from_event: string;
    to_event: string;
    sla_ms: number | string;
    min_count: number;
  }>;
  // `sla_ms` is a bigint in Postgres; postgrest returns it as string OR number depending on client version.
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    from_event: r.from_event,
    to_event: r.to_event,
    sla_ms: typeof r.sla_ms === "string" ? Number.parseInt(r.sla_ms, 10) : r.sla_ms,
    min_count: r.min_count,
  }));
}

/**
 * Read the last N timecard events for a spec, newest-first. Powers the MarioBrief.
 */
async function readLastEvents(
  admin: Admin,
  workspace_id: string,
  spec_slug: string,
): Promise<MarioBrief["last_events"]> {
  const { data, error } = await admin
    .from("spec_timecard_events")
    .select("event_kind, phase_index, actor, at, wait_kind, waiting_on")
    .eq("workspace_id", workspace_id)
    .eq("spec_slug", spec_slug)
    .order("at", { ascending: false })
    .limit(BRIEF_EVENT_LIMIT);
  if (error) throw error;
  return (data ?? []) as MarioBrief["last_events"];
}

/**
 * Read the CURRENT active agent_jobs row for a spec (the live build/fold lane).
 * "Active" = any status in {@link ACTIVE_STATUSES}. `null` when nothing is live.
 */
async function readCurrentJobStatus(
  admin: Admin,
  workspace_id: string,
  spec_slug: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("agent_jobs")
    .select("status")
    .eq("workspace_id", workspace_id)
    .eq("spec_slug", spec_slug)
    .in("status", Array.from(ACTIVE_STATUSES))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.status ?? null;
}

/**
 * The legit-wait discriminator's job-side statuses. A live job in ANY of these
 * is waiting on a real signal (a human answer, an approval, an upstream spec, or
 * usage reset) — DROP the candidate.
 */
const LEGIT_WAIT_JOB_STATUSES: ReadonlySet<string> = new Set([
  "blocked_on_dependency",
  "blocked_on_usage",
  "needs_input",
  "needs_approval",
]);

/**
 * Grace window before a FAILED build is treated as a stall. A build can go `failed` transiently and be
 * auto-reaped / re-driven by the worker (orphan-reaper, RERUNNABLE_KINDS) within minutes; Mario should
 * only fire once it's clear nothing re-drove it. 20 min is comfortably past the worker's own recovery loop.
 */
const MARIO_FAILED_BUILD_GRACE_MS = 20 * 60 * 1000;

/**
 * SECOND candidate source (failed/orphaned builds). Mario's primary detector keys on timecard
 * `from_event → to_event` gaps, but a build that dies AFTER claiming — orphaned by a worker restart,
 * crashed, or errored — emits NO `build_done` event, so no happy-path threshold ever fires and the dead
 * build sits stranded forever. Worse, a build that died before the chokepoint instrumentation went live
 * has NO timecard events at all, so it is invisible to the threshold scan entirely. This reads the
 * failure signal straight from `agent_jobs`: a spec whose LATEST build job is `failed` (so it was not
 * superseded by a newer active/completed build) and older than the grace window. The caller runs these
 * through the SAME (b)/(c)/(d) drop filters as the timecard candidates, so a blocked / terminal / phantom
 * spec is still dropped.
 */
async function readFailedBuildStalls(
  admin: Admin,
  workspace_id: string,
  graceMs: number,
): Promise<Array<{ workspace_id: string; spec_slug: string; age_ms: number }>> {
  const now = Date.now();
  const { data, error } = await admin
    .from("agent_jobs")
    .select("spec_slug, status, updated_at")
    .eq("workspace_id", workspace_id)
    .eq("kind", "build")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  // First (newest) row per spec = its latest build attempt.
  const latestBySlug = new Map<string, { status: string; updated_at: string }>();
  for (const j of (data ?? []) as Array<{ spec_slug: string; status: string; updated_at: string }>) {
    if (!j.spec_slug || latestBySlug.has(j.spec_slug)) continue;
    latestBySlug.set(j.spec_slug, { status: j.status, updated_at: j.updated_at });
  }
  const out: Array<{ workspace_id: string; spec_slug: string; age_ms: number }> = [];
  for (const [slug, j] of latestBySlug) {
    if (j.status !== "failed" || !j.updated_at) continue;
    const age = now - Date.parse(j.updated_at);
    if (age > graceMs) out.push({ workspace_id, spec_slug: slug, age_ms: age });
  }
  return out;
}

/** Grace before a loop-guard-escalated spec is treated as a stall — same shape as the failed-build grace. */
const MARIO_PROMOTE_GATE_GRACE_MS = 20 * 60 * 1000;
/** How far back to scan for loop-guard escalations (bounds the director_activity read). */
const MARIO_PROMOTE_GATE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * THIRD candidate source (promote-gate held / loop-guard escalated). A spec can pass every step — review,
 * build, spec-test — yet be HELD unmerged because its spec-test verdict was `issues` and the pre-merge fix
 * loop-guard fired (`PRE_MERGE_FIX_LOOP_GUARD_MAX` fix phases already, still red → "a deeper issue than
 * another Fix N can solve", `director_activity` action_kind='escalated', metadata.signature=
 * 'fixes-as-phases-loop-guard'). Its LAST timecard event is a terminal verdict (`spec_test_verdict` /
 * `security_verdict`) — no open `from → to` gap — and its build COMPLETED (not failed), so neither the
 * timecard thresholds nor the failed-build source sees it. This reads the escalation signal straight from
 * `director_activity`, then confirms the spec is STILL held (latest spec_test_run verdict is still `issues`)
 * so a since-resolved spec never re-fires. The caller runs these through the SAME (b)/(c)/(d) drop filters.
 */
async function readPromoteGateHeldStalls(
  admin: Admin,
  workspace_id: string,
  graceMs: number,
): Promise<Array<{ workspace_id: string; spec_slug: string; age_ms: number }>> {
  const now = Date.now();
  const { data: escRows, error } = await admin
    .from("director_activity")
    .select("spec_slug, created_at")
    .eq("workspace_id", workspace_id)
    .eq("action_kind", "escalated")
    .eq("metadata->>signature", "fixes-as-phases-loop-guard")
    .gte("created_at", new Date(now - MARIO_PROMOTE_GATE_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  // Latest escalation per spec, past the grace window.
  const latestBySlug = new Map<string, string>();
  for (const r of (escRows ?? []) as Array<{ spec_slug: string | null; created_at: string }>) {
    if (!r.spec_slug || latestBySlug.has(r.spec_slug)) continue;
    latestBySlug.set(r.spec_slug, r.created_at);
  }
  const aged = [...latestBySlug.entries()].filter(([, at]) => now - Date.parse(at) > graceMs);
  if (aged.length === 0) return [];

  // Confirm STILL held: the latest spec_test_run for the slug must still be `issues`. A spec whose next
  // spec-test flipped to `approved` (e.g. its verification was repaired) is resolved — never re-fire it.
  const slugs = aged.map(([slug]) => slug);
  const { data: runs } = await admin
    .from("spec_test_runs")
    .select("spec_slug, agent_verdict, run_at")
    .eq("workspace_id", workspace_id)
    .in("spec_slug", slugs)
    .order("run_at", { ascending: false })
    .limit(1000);
  const latestVerdict = new Map<string, string>();
  for (const r of (runs ?? []) as Array<{ spec_slug: string; agent_verdict: string }>) {
    if (!latestVerdict.has(r.spec_slug)) latestVerdict.set(r.spec_slug, r.agent_verdict);
  }
  const out: Array<{ workspace_id: string; spec_slug: string; age_ms: number }> = [];
  for (const [slug, at] of aged) {
    if (latestVerdict.get(slug) !== "issues") continue; // resolved / no run → not held
    out.push({ workspace_id, spec_slug: slug, age_ms: now - Date.parse(at) });
  }
  return out;
}

/**
 * `evaluateStalledSpecs` — the M3 detector cron's core. Returns EXACTLY the specs
 * whose next lifecycle step is genuinely overdue.
 *
 * Steps (mirrors the spec's a-e):
 *  (a) reads every mario_thresholds row for the workspace and, per row, calls
 *      `listStalledCandidates(admin, { older_than_ms: sla_ms })` — filtered to
 *      the candidates whose `last_event_kind === from_event`, so a stall against
 *      this threshold means "the last event WAS from_event and to_event has not
 *      landed within sla_ms".
 *  (b) DROPS a candidate whose `getSpecBlockers` shows any entry with
 *      `cleared:false` — an uncleared blocker is a legit wait (blockers gate a
 *      build; a gated build cannot stall by definition).
 *  (c) DROPS a candidate whose current active agent_jobs.status is in
 *      { blocked_on_dependency, blocked_on_usage, needs_input, needs_approval } —
 *      the job is intentionally paused; the ledger's silence is expected, not a
 *      stall.
 *  (d) DROPS a candidate whose spec status is `folded` (fold-cooldown) — a
 *      folded row stopped emitting events on purpose.
 *  (e) attaches a MarioBrief to every surviving candidate so the M4 reasoning
 *      agent picks up the last 10 events + blockedBy state + current job status
 *      without another read.
 *
 * Idempotent (read-only). Safe to call every minute from the cron.
 */
export async function evaluateStalledSpecs(
  admin: Admin,
  workspace_id?: string,
): Promise<StalledCandidate[]> {
  const thresholds = await readThresholds(admin, workspace_id);
  if (thresholds.length === 0) return [];

  // (a) per-threshold scans. Same `(workspace_id, spec_slug)` pair can surface
  // under multiple thresholds — first hit (in threshold read order) wins; a
  // subsequent hit for the same spec is dropped so the M4 lane never sees two
  // candidates for one spec.
  const seen = new Set<string>();
  const initial: StalledCandidate[] = [];
  for (const t of thresholds) {
    const rows = await listStalledCandidates(admin, {
      workspace_id: t.workspace_id,
      older_than_ms: t.sla_ms,
    });
    for (const r of rows) {
      // The threshold's `from_event` is the opening side — only surface the
      // candidate under this threshold when the LAST event equals `from_event`.
      // A stalled candidate whose last event is anything else belongs to a
      // different threshold (or is unmapped — handled by future thresholds).
      if (r.last_event_kind !== t.from_event) continue;
      const key = `${r.workspace_id}::${r.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: r.workspace_id,
        spec_slug: r.spec_slug,
        from_event: t.from_event,
        to_event: t.to_event,
        gap_ms: r.gap_ms,
        sla_ms: t.sla_ms,
        // brief filled in below after the drop filters — no point paying the
        // three-read cost on a candidate we're about to drop.
        brief: { last_events: [], blocked_by_state: [], current_job_status: null },
      });
    }
  }

  // (a2) SECOND candidate source — failed/orphaned builds (see `readFailedBuildStalls`). Scoped to the
  // same workspaces the thresholds cover (a workspace with no thresholds is not monitored). Deduped
  // against the timecard candidates via `seen`, then run through the SAME (b)/(c)/(d) filters below.
  const wsIds = workspace_id ? [workspace_id] : [...new Set(thresholds.map((t) => t.workspace_id))];
  for (const ws of wsIds) {
    const failed = await readFailedBuildStalls(admin, ws, MARIO_FAILED_BUILD_GRACE_MS);
    for (const fb of failed) {
      const key = `${fb.workspace_id}::${fb.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: fb.workspace_id,
        spec_slug: fb.spec_slug,
        // Semantic: the build STARTED (claimed) but never reached build_done — it died mid-flight.
        from_event: "build_started",
        to_event: "build_done",
        gap_ms: fb.age_ms,
        sla_ms: MARIO_FAILED_BUILD_GRACE_MS,
        // Pre-seed the failure signal so the brief surfaces it even when the ledger is empty for this spec;
        // step (e) preserves it when there is no ACTIVE job (readCurrentJobStatus returns null on `failed`).
        brief: { last_events: [], blocked_by_state: [], current_job_status: "failed" },
      });
    }

    // (a3) THIRD candidate source — promote-gate held / loop-guard escalated (see readPromoteGateHeldStalls).
    const held = await readPromoteGateHeldStalls(admin, ws, MARIO_PROMOTE_GATE_GRACE_MS);
    for (const hb of held) {
      const key = `${hb.workspace_id}::${hb.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: hb.workspace_id,
        spec_slug: hb.spec_slug,
        // Semantic: the spec-test verdicted `issues` but the spec never promoted (held after loop-guard).
        from_event: "spec_test_verdict",
        to_event: "promoted",
        gap_ms: hb.age_ms,
        sla_ms: MARIO_PROMOTE_GATE_GRACE_MS,
        brief: { last_events: [], blocked_by_state: [], current_job_status: "spec_test_issues_loop_guard" },
      });
    }
  }

  const survivors: StalledCandidate[] = [];
  for (const c of initial) {
    // (b) uncleared blockedBy → legit wait, drop.
    const blockers = await getSpecBlockers(c.spec_slug);
    if (blockers.some((b) => !b.cleared)) continue;

    // (c) active job in a wait status → legit wait, drop.
    const currentJobStatus = await readCurrentJobStatus(admin, c.workspace_id, c.spec_slug);
    if (currentJobStatus !== null && LEGIT_WAIT_JOB_STATUSES.has(currentJobStatus)) continue;

    // (d) fold-cooldown / explicitly-deferred → the spec stopped emitting events
    // on purpose; drop. Reads through the specs-table getSpec (which carries the
    // raw override statuses, unlike the derived brain-roadmap SpecStatus that
    // normalizes `folded` → `shipped`).
    const specRow = await getSpecFromDb(c.workspace_id, c.spec_slug);
    // (d0) NO `public.specs` row at all → PHANTOM: the triggering timecard event was backfilled from a
    // `spec_status_history` row whose spec authorship FAILED (e.g. InvalidParentError at the chokepoint) and
    // never became a real spec. There is no pipeline to plumb — drop it so Mario is never fired on a ghost.
    // (Previously the `specRow && …` guard below short-circuited to false on a null row, letting the phantom
    // survive the filter chain and enqueue a mario job — the false-trigger class from Mario's first sweep.)
    if (!specRow) continue;
    if (specRow.status === "folded" || specRow.status === "deferred") continue;

    // (e) fill the brief now that the candidate survived every filter.
    const lastEvents = await readLastEvents(admin, c.workspace_id, c.spec_slug);
    survivors.push({
      ...c,
      brief: {
        last_events: lastEvents,
        blocked_by_state: blockers.map((b) => ({ slug: b.slug, cleared: b.cleared })),
        // Prefer a live active status; else keep the candidate's pre-seeded status (e.g. `failed` from the
        // failed-build source) so the brief never hides a dead build behind a null.
        current_job_status: currentJobStatus ?? c.brief.current_job_status,
      },
    });
  }

  return survivors;
}

/**
 * `enqueueMarioJob` — file a kind='mario' [[agent_jobs]] row for a stalled
 * candidate, gated on "no active mario row for this spec_slug already exists".
 *
 * Dedupe contract (from the spec): SELECT any active mario row on `spec_slug`
 * with status in the ACTIVE set; if one exists, return
 * `{ enqueued: false, reason: 'active_mario_exists' }`, else INSERT a fresh
 * row with the MarioBrief JSON-encoded on `instructions` so the M4 reasoning
 * agent picks it up.
 *
 * This is app-layer dedupe (SELECT-then-INSERT) — safe under the once-per-minute
 * cron because at most one tick evaluates a given spec at a time. A cross-cron
 * race would insert a second row; M4's own claim step is designed to no-op on
 * that (the FIRST claim wins; the second becomes a no-op mario tick).
 */
export async function enqueueMarioJob(
  admin: Admin,
  candidate: StalledCandidate,
): Promise<{ enqueued: boolean; job_id?: string; reason?: string }> {
  // SELECT for an active mario row on this spec_slug. Filter by workspace_id
  // AND kind AND spec_slug — never rely on spec_slug alone (cross-workspace
  // spec-slug collisions do happen for the same brain page under two tenants).
  const { data: existing, error: selectErr } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("workspace_id", candidate.workspace_id)
    .eq("kind", "mario")
    .eq("spec_slug", candidate.spec_slug)
    .in("status", Array.from(ACTIVE_MARIO_STATUSES))
    .limit(1)
    .maybeSingle();
  if (selectErr) throw selectErr;
  if (existing) return { enqueued: false, reason: "active_mario_exists" };

  // Re-fire COOLDOWN. The active-mario dedupe above only blocks a CONCURRENT job — the moment a mario job
  // COMPLETES with an escalate (or a fix that didn't clear the stall), the underlying stall persists, so
  // the next ~1-min cron sweep re-enqueues, and Mario burns a Max session investigating the SAME spec every
  // minute forever (an escalate loop the `mario_fixed` loop-guard never catches, because escalations are
  // `mario_fired`, not `mario_fixed`). Suppress a re-fire when Mario ALREADY fired on this spec within the
  // cooldown window: if it's still stalled an hour later, one look per hour is plenty; a live-fix that
  // actually cleared it removes the spec from the candidate set anyway, so the cooldown only bites the
  // unresolved (escalated / fix-didn't-take) case — exactly the loop we want to break.
  const cooldownSince = new Date(Date.now() - MARIO_REFIRE_COOLDOWN_MS).toISOString();
  const { data: recentFire } = await admin
    .from("director_activity")
    .select("id")
    .eq("workspace_id", candidate.workspace_id)
    .eq("spec_slug", candidate.spec_slug)
    .eq("action_kind", "mario_fired")
    .gte("created_at", cooldownSince)
    .limit(1);
  if (recentFire && recentFire.length > 0) return { enqueued: false, reason: "refire_cooldown" };

  const { data: inserted, error: insertErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: candidate.workspace_id,
      kind: "mario",
      status: "queued",
      spec_slug: candidate.spec_slug,
      instructions: JSON.stringify(candidate.brief),
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;
  return { enqueued: true, job_id: inserted.id };
}

/**
 * Convenience: read the workspace-scoped thresholds without going through the
 * evaluator. Handy for the M4 self-tuner (which reads to widen an SLA).
 */
export async function readMarioThresholds(admin: Admin, workspace_id: string): Promise<MarioThreshold[]> {
  return readThresholds(admin, workspace_id);
}

/**
 * Default admin factory — the cron passes its own client to
 * `evaluateStalledSpecs` and `enqueueMarioJob`; a caller from a route can grab a
 * client here without importing `@/lib/supabase/admin` directly.
 */
export function marioAdmin(): SupabaseClient {
  return createAdminClient();
}

// ── M4 Phase 1: dispatch wiring types + minimal appliers ────────────────────────
// The runner (scripts/builder-worker.ts `runMarioJob`) parses Mario's terminal
// JSON into `MarioVerdict`, hands the typed verdict to `applyBoxMario`, and on any
// exception (or unparseable verdict after same-session repair) hands the job to
// `failsafeStampMarioUnsure`. Phase 3 replaces `applyBoxMario`'s body with the
// full kill-switch + loop-guard + non-destructive live-fix vocabulary + fix-spec
// authoring + threshold self-tune; the Phase-1 body is a conservative stub that
// records the verdict on `director_activity` (`mario_fired`) and completes the
// job — NEVER executes any live_fix / threshold widen / fix-spec author.

/** The supervising director slug ([[../../docs/brain/functions/platform.md]] Ada). */
const MARIO_DIRECTOR_FUNCTION = "platform";
/** The named actor for every director_activity row Mario writes (matches Reva's `GUARDIAN_ACTOR` pattern). */
const MARIO_ACTOR = "mario";

/** One non-destructive live fix in the M4 vocabulary — the exact action key + its target. */
export interface MarioLiveFix {
  /** Vocabulary key: redrive_dropped_job | unstick_stale_status | release_cleared_blocker | requeue_unclaimed_job | queue_box_restart | reclaim_and_redrive | ...open slot. */
  action: string;
  /** The specific row/slug/box the action mutates — Phase 3 helpers each read exactly one field. */
  target: { spec_slug?: string; job_id?: string; box_id?: string };
  /** Plain-language why — persisted verbatim on the director_activity row. */
  reasoning: string;
}

/** The critical fix-spec Mario proposes when the stall class is likely recurring. */
export interface MarioDurableFixSpec {
  slug: string;
  title: string;
  why: string;
  what: string;
  phases: Array<{ title: string; why: string; what: string; body: string; verification: string }>;
}

/** A repair of a spec's MALFORMED verification — the un-passable-pre-merge / self-referential checks that
 *  spin the pre-merge fix loop-guard (a runtime-only "re-trigger the cron and watch the tile" bullet the
 *  spec-test agent mis-classifies as an auto-fail; or a Fix phase whose verification re-checks the origin's
 *  own future spec_test_runs). Mario proposes CORRECTED, locally-checkable verification per REAL phase; the
 *  applier re-authors the spec with it and DROPS the auto-generated Fix phases (which caused the loop). */
export interface MarioVerificationRepair {
  spec_slug: string;
  /** Corrected verification for each real (kind='phase') phase — matched by exact `title` or 1-based `position`. */
  phases: Array<{ title?: string; position?: number; verification: string }>;
  reasoning: string;
}

/** The self-tuning widen Mario proposes when a false trigger fires — Phase 3 gates on a non-empty reason. */
export interface MarioThresholdAdjustment {
  from_event: string;
  to_event: string;
  new_sla_ms: number;
  reason: string;
}

/**
 * The terminal JSON envelope Mario emits. Every field is optional in the raw
 * output — `normalizeMarioVerdict` fills in the conservative defaults so the
 * runner never has to defend against a partial shape.
 */
export interface MarioVerdict {
  trigger_accurate: boolean;
  live_fix: MarioLiveFix | null;
  durable_fix_spec: MarioDurableFixSpec | null;
  verification_repair: MarioVerificationRepair | null;
  threshold_adjustment: MarioThresholdAdjustment | null;
  escalate: boolean;
  reasoning: string;
}

/**
 * Conservative default handed back on an unparseable verdict AFTER same-session
 * repair fails. The runner uses this shape when it needs to record a
 * shape-safe "we gave up" — never as a substitute for calling
 * `failsafeStampMarioUnsure`.
 */
export const MARIO_CONSERVATIVE_DEFAULT_VERDICT: MarioVerdict = {
  trigger_accurate: false,
  live_fix: null,
  durable_fix_spec: null,
  verification_repair: null,
  threshold_adjustment: null,
  escalate: true,
  reasoning: "unparseable verdict",
};

/**
 * `normalizeMarioVerdict` — turn a raw parsed JSON blob into a `MarioVerdict` or
 * `null` if the shape can't be salvaged. Never throws. Missing/invalid fields
 * fall back to the conservative-safe value (unknown → escalate; missing
 * live_fix → null; a malformed live_fix.action drops the whole live_fix). The
 * function is deliberately generous on the READ side and strict on the WRITE
 * side (Phase 3 helpers each re-validate before mutating).
 */
export function normalizeMarioVerdict(raw: unknown): MarioVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const reasoning = typeof r.reasoning === "string" ? r.reasoning : "";
  const trigger_accurate = r.trigger_accurate === true;
  const escalate = r.escalate === true;

  let live_fix: MarioLiveFix | null = null;
  if (r.live_fix && typeof r.live_fix === "object") {
    const lf = r.live_fix as Record<string, unknown>;
    const action = typeof lf.action === "string" ? lf.action : "";
    if (action) {
      const target = (lf.target && typeof lf.target === "object" ? lf.target : {}) as Record<string, unknown>;
      live_fix = {
        action,
        target: {
          spec_slug: typeof target.spec_slug === "string" ? target.spec_slug : undefined,
          job_id: typeof target.job_id === "string" ? target.job_id : undefined,
          box_id: typeof target.box_id === "string" ? target.box_id : undefined,
        },
        reasoning: typeof lf.reasoning === "string" ? lf.reasoning : "",
      };
    }
  }

  let durable_fix_spec: MarioDurableFixSpec | null = null;
  if (r.durable_fix_spec && typeof r.durable_fix_spec === "object") {
    const d = r.durable_fix_spec as Record<string, unknown>;
    const slug = typeof d.slug === "string" ? d.slug : "";
    const title = typeof d.title === "string" ? d.title : "";
    if (slug && title) {
      const rawPhases = Array.isArray(d.phases) ? d.phases : [];
      const phases = rawPhases.map((p) => {
        const o = (p || {}) as Record<string, unknown>;
        return {
          title: typeof o.title === "string" ? o.title : "",
          why: typeof o.why === "string" ? o.why : "",
          what: typeof o.what === "string" ? o.what : "",
          body: typeof o.body === "string" ? o.body : "",
          verification: typeof o.verification === "string" ? o.verification : "",
        };
      });
      durable_fix_spec = {
        slug,
        title,
        why: typeof d.why === "string" ? d.why : "",
        what: typeof d.what === "string" ? d.what : "",
        phases,
      };
    }
  }

  let verification_repair: MarioVerificationRepair | null = null;
  if (r.verification_repair && typeof r.verification_repair === "object") {
    const v = r.verification_repair as Record<string, unknown>;
    const spec_slug = typeof v.spec_slug === "string" ? v.spec_slug : "";
    const rawPhases = Array.isArray(v.phases) ? v.phases : [];
    const phases = rawPhases
      .map((p) => {
        const o = (p || {}) as Record<string, unknown>;
        const verification = typeof o.verification === "string" ? o.verification : "";
        const position = typeof o.position === "number" ? o.position : undefined;
        const title = typeof o.title === "string" ? o.title : undefined;
        return { title, position, verification };
      })
      .filter((p) => p.verification.trim().length > 0 && (p.title || p.position != null));
    if (spec_slug && phases.length > 0) {
      verification_repair = { spec_slug, phases, reasoning: typeof v.reasoning === "string" ? v.reasoning : "" };
    }
  }

  let threshold_adjustment: MarioThresholdAdjustment | null = null;
  if (r.threshold_adjustment && typeof r.threshold_adjustment === "object") {
    const t = r.threshold_adjustment as Record<string, unknown>;
    const from_event = typeof t.from_event === "string" ? t.from_event : "";
    const to_event = typeof t.to_event === "string" ? t.to_event : "";
    const rawSla = t.new_sla_ms;
    const new_sla_ms = typeof rawSla === "number" ? rawSla : Number.parseInt(String(rawSla ?? ""), 10);
    if (from_event && to_event && Number.isFinite(new_sla_ms) && new_sla_ms > 0) {
      threshold_adjustment = {
        from_event,
        to_event,
        new_sla_ms,
        reason: typeof t.reason === "string" ? t.reason : "",
      };
    }
  }

  return { trigger_accurate, live_fix, durable_fix_spec, verification_repair, threshold_adjustment, escalate, reasoning };
}

/** The result `applyBoxMario` hands back to the runner. */
export interface ApplyBoxMarioResult {
  ok: boolean;
  reason?: string;
  recorded?: boolean;
  fix_executed?: boolean;
  fix_reason?: string;
  durable_spec_authored?: boolean;
  threshold_widened?: boolean;
  loop_guard_triggered?: boolean;
  mode?: MarioAutonomyMode;
}

// ── Phase 3: kill-switch + loop-guard + non-destructive vocabulary + fix-spec author + self-tune ─

/** Env keys — surfaced so Phase 4's dashboard/probe can name them consistently. */
export const MARIO_AUTONOMY_MODE_ENV = "MARIO_AUTONOMY_MODE";
export const MARIO_LOOP_GUARD_MAX_ENV = "MARIO_LOOP_GUARD_MAX";
export const MARIO_ACCURACY_ALARM_PCT_ENV = "MARIO_ACCURACY_ALARM_PCT";

export type MarioAutonomyMode = "live" | "surface_only" | "off";

/** Read the kill-switch. Anything unrecognized defaults to `live` — the fail-safe is Mario runs. */
export function readMarioAutonomyMode(): MarioAutonomyMode {
  const v = (process.env[MARIO_AUTONOMY_MODE_ENV] ?? "").toLowerCase().trim();
  if (v === "off") return "off";
  if (v === "surface_only") return "surface_only";
  return "live";
}

/** Default loop-guard max — a slug re-fired 3+ times in 24h is a deeper issue than a live fix can close. */
const MARIO_LOOP_GUARD_DEFAULT_MAX = 3;

/** Read the loop-guard max — env-overridable, mirrors DEPLOY_GUARDIAN_LOOP_GUARD_MAX's shape. */
export function readMarioLoopGuardMax(): number {
  const raw = process.env[MARIO_LOOP_GUARD_MAX_ENV];
  const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : MARIO_LOOP_GUARD_DEFAULT_MAX;
}

/** Read the accuracy-alarm threshold pct (0-100). Default 60 — under this, Mario surfaces to Ada. */
const MARIO_ACCURACY_ALARM_DEFAULT_PCT = 60;
export function readMarioAccuracyAlarmPct(): number {
  const raw = process.env[MARIO_ACCURACY_ALARM_PCT_ENV];
  const n = raw != null ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : MARIO_ACCURACY_ALARM_DEFAULT_PCT;
}

/** Count prior `mario_fixed` director_activity rows for THIS spec_slug in the last 24h — the loop-guard input. */
async function countPriorMarioFixesForSlug(
  admin: Admin,
  workspaceId: string,
  specSlug: string | null,
): Promise<number> {
  if (!specSlug) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await admin
    .from("director_activity")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("action_kind", "mario_fixed")
    .eq("spec_slug", specSlug)
    .gte("created_at", since);
  if (error) return 0;
  return count ?? 0;
}

// ── Vocabulary helpers — each does exactly one non-destructive UPDATE via createAdminClient() ─
//    A helper throws when its `target.<field>` is missing / no row matches; applyBoxMario catches
//    and records the reason on the mario_fired row (so the audit ledger explains why the fix
//    didn't land instead of silently no-op'ing).

/** `redrive_dropped_job` — flip an in-flight (`building`|`claimed`) row back to `queued` so the next worker
 *  claims it fresh. Compare-and-set: only mutates rows currently in-flight; a row already terminal (done /
 *  cancelled / failed) NEVER regresses. `target.job_id` REQUIRED. */
async function redriveDroppedJob(admin: Admin, targetJobId: string, workspaceId: string): Promise<void> {
  const { data: updated, error } = await admin
    .from("agent_jobs")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("id", targetJobId)
    .eq("workspace_id", workspaceId)
    .in("status", ["building", "claimed"])
    .select("id");
  if (error) throw new Error(`redrive_dropped_job: ${error.message}`);
  if (!Array.isArray(updated) || updated.length === 0) throw new Error("redrive_dropped_job: no in-flight row matched");
}

/** `unstick_stale_status` — flip a row wedged in `claimed` (no worker heartbeat) back to `queued`. Same
 *  compare-and-set shape as redrive — the only allowed status transition is `claimed`→`queued` (the
 *  narrower predicate distinguishes it from `redrive_dropped_job` which also handles `building`). */
async function unstickStaleStatus(admin: Admin, targetJobId: string, workspaceId: string): Promise<void> {
  const { data: updated, error } = await admin
    .from("agent_jobs")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("id", targetJobId)
    .eq("workspace_id", workspaceId)
    .eq("status", "claimed")
    .select("id");
  if (error) throw new Error(`unstick_stale_status: ${error.message}`);
  if (!Array.isArray(updated) || updated.length === 0) throw new Error("unstick_stale_status: no claimed row matched");
}

/** `release_cleared_blocker` — nudge autoQueueUnblockedBy for a spec whose blockedBy chain is now clear
 *  but the auto-queue path missed the transition. Reads through the same fan-out the merge path uses so a
 *  race with the shipping merge is idempotent. */
async function releaseClearedBlocker(_admin: Admin, workspaceId: string, specSlug: string): Promise<void> {
  const { autoQueueUnblockedBy } = await import("@/lib/agent-jobs");
  const queued = await autoQueueUnblockedBy(workspaceId, specSlug);
  if (queued.length === 0) throw new Error("release_cleared_blocker: no downstream slug was queued");
}

/** `requeue_unclaimed_job` — flip a queued row's `updated_at` so the next poll cycle re-picks it (an
 *  idempotent re-queue: the row was already `queued` but starved). Compare-and-set on `status='queued'`. */
async function requeueUnclaimedJob(admin: Admin, targetJobId: string, workspaceId: string): Promise<void> {
  const { data: updated, error } = await admin
    .from("agent_jobs")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", targetJobId)
    .eq("workspace_id", workspaceId)
    .eq("status", "queued")
    .select("id");
  if (error) throw new Error(`requeue_unclaimed_job: ${error.message}`);
  if (!Array.isArray(updated) || updated.length === 0) throw new Error("requeue_unclaimed_job: no queued row matched");
}

/** `queue_box_restart` — set `worker_controls.drain_for_update=true` for the target box so the worker
 *  restarts at idle (matches scripts/builder-worker.ts:2928-2983's drain-for-update contract). Never
 *  kills a live session. */
async function queueBoxRestart(admin: Admin, boxId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await admin
    .from("worker_controls")
    .upsert(
      {
        box_id: boxId,
        drain_for_update: true,
        requested_by: "mario",
        requested_at: nowIso,
        updated_at: nowIso,
      },
      { onConflict: "box_id" },
    );
  if (error) throw new Error(`queue_box_restart: ${error.message}`);
}

/** `reclaim_and_redrive` — unstick a spec whose LATEST build FAILED/orphaned (the built-but-unmerged class:
 *  a build orphaned by a worker restart, or one left on a stale/conflicting branch). Unlike the status-flip
 *  actions above, a `failed` build has NO in-flight row to flip — this enqueues a FRESH build, which rebases
 *  onto current `main` → a clean, non-conflicting branch → a clean merge. The worker's own worktree
 *  self-heal (`ensureWorktreeSlotFree`) frees a `BUILDS_DIR`-pinned branch before the rebuild; the narrower
 *  ephemeral `/tmp`-pinned case is handled by the `builder-worktree-self-heal` fix-spec. Routes through the
 *  sanctioned `queueRoadmapBuild` (owner-gated) so every blocker / active-build / review guard still applies. */
export async function reclaimAndRedrive(admin: Admin, workspaceId: string, specSlug: string): Promise<void> {
  const { data: owner, error: ownerErr } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("role", "owner")
    .maybeSingle();
  if (ownerErr) throw new Error(`reclaim_and_redrive: owner lookup failed: ${ownerErr.message}`);
  if (!owner) throw new Error("reclaim_and_redrive: no workspace owner");
  const { queueRoadmapBuild } = await import("@/lib/roadmap-actions");
  const res = await queueRoadmapBuild(workspaceId, (owner as { user_id: string }).user_id, { slug: specSlug });
  if (!res.ok) throw new Error(`reclaim_and_redrive: queueRoadmapBuild: ${res.error}`);
}

/** Widen the SLA row for `(workspace_id, from_event, to_event)` and stamp `last_widened_at` + reason.
 *  Compare-and-set on the (workspace, pair) unique key so a cross-workspace slug collision can't cross-write. */
async function widenMarioThreshold(
  admin: Admin,
  workspaceId: string,
  adj: MarioThresholdAdjustment,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await admin
    .from("mario_thresholds")
    .update({
      sla_ms: adj.new_sla_ms,
      last_widened_at: nowIso,
      last_widened_reason: adj.reason,
      updated_at: nowIso,
    })
    .eq("workspace_id", workspaceId)
    .eq("from_event", adj.from_event)
    .eq("to_event", adj.to_event)
    .select("id");
  if (error) throw new Error(`widen_threshold: ${error.message}`);
  return Array.isArray(updated) && updated.length > 0;
}

/** The platform mandate Mario's durable fix-specs live under. A spec's parent MUST be a mandate or a
 *  milestone — the author chokepoint (`assertValidParent`) THROWS `InvalidParentError` on a BARE function
 *  parent ("parent read as free text"). A bare-function parent was the silent-author-failure bug: every
 *  proposed fix-spec threw at the chokepoint and was swallowed, so nothing persisted. */
const MARIO_FIX_MANDATE_SLUG = "infra-devops-reliability"; // platform.md § "Infra & DevOps / reliability"

/** Author a critical fix-spec via `authorSpecRowStructured` — owner='platform', critical, autoBuild.
 *  Parent is the platform **mandate** (not a bare function — that throws InvalidParentError); Vale's
 *  `assertEveryPhaseHasVerification` + `assertEveryNodeHasIntent` re-gate the payload at the DB write. */
async function authorMarioFixSpec(
  workspaceId: string,
  fixSpec: MarioDurableFixSpec,
): Promise<boolean> {
  const { authorSpecRowStructured } = await import("@/lib/author-spec");
  return await authorSpecRowStructured(
    workspaceId,
    fixSpec.slug,
    {
      title: fixSpec.title,
      summary: null,
      owner: MARIO_DIRECTOR_FUNCTION,
      parent: `[[../functions/platform]] — "Infra & DevOps / reliability" mandate: Mario's durable pipeline-reliability fix so this stall class cannot recur.`,
      why: fixSpec.why,
      what: fixSpec.what,
      critical: true,
      autoBuild: true,
      phases: fixSpec.phases.map((p) => ({
        title: p.title,
        body: p.body,
        verification: p.verification,
        why: p.why,
        what: p.what,
      })),
    },
    "planned",
    { intendedStatusSetBy: "mario", parentKind: "mandate", parentRef: `${MARIO_DIRECTOR_FUNCTION}#${MARIO_FIX_MANDATE_SLUG}` },
  );
}

/** Repair a spec's MALFORMED verification (the promote-gate-held / loop-guard class). Re-authors the spec
 *  with Mario's corrected, locally-checkable verification for each REAL phase and DROPS the auto-generated
 *  Fix phases (whose self-referential verification caused the loop). The re-author re-opens the spec →
 *  Vale re-reviews → it rebuilds → the pre-merge spec-test now has a passable check → it promotes. This is
 *  the same mechanism a human uses to fix a malformed verification; Mario proposes the corrected checks. */
async function repairSpecVerification(admin: Admin, workspaceId: string, repair: MarioVerificationRepair): Promise<boolean> {
  const { getSpec } = await import("@/lib/specs-table");
  const { authorSpecRowStructured } = await import("@/lib/author-spec");
  const cur = await getSpec(workspaceId, repair.spec_slug);
  if (!cur) throw new Error(`repair_verification: spec ${repair.spec_slug} not found`);
  const realPhases = (cur.phases ?? []).filter((p) => p.kind !== "fix");
  if (realPhases.length === 0) throw new Error("repair_verification: no non-fix phases to repair");

  const byTitle = new Map(repair.phases.filter((p) => p.title).map((p) => [p.title as string, p.verification]));
  const byPos = new Map(repair.phases.filter((p) => p.position != null).map((p) => [p.position as number, p.verification]));
  const phases = realPhases.map((p) => ({
    title: p.title,
    // Intent gate needs non-empty why/what per phase — fall back to spec-level intent (a repair-agent spec
    // often authored phases with empty why/what before the intent gate landed).
    why: (p.why && p.why.trim()) || cur.why || `Phase ${p.position} of ${cur.title}.`,
    what: (p.what && p.what.trim()) || cur.what || cur.title,
    body: (p.body && p.body.trim()) || p.title,
    // Mario's corrected verification for this phase (by title or position); else keep the current one. The
    // Verification gate throws on an empty string, so a phase Mario left uncorrected must already have one.
    verification: byTitle.get(p.title) ?? byPos.get(p.position) ?? p.verification ?? "",
  }));

  // Preserve a typed mandate parent when the spec has one; else fall back to the owner's reliability
  // mandate (the common case for repair-agent/platform specs). A bare-function parent throws
  // InvalidParentError, so we never pass one through.
  const hasTypedMandate = cur.parent_kind === "mandate" && typeof cur.parent_ref === "string" && cur.parent_ref.includes("#");
  const parentRef = hasTypedMandate ? (cur.parent_ref as string) : `${cur.owner}#infra-devops-reliability`;
  const parentProse = cur.parent && cur.parent.includes("mandate") ? cur.parent : `[[../functions/${cur.owner}]] — "Infra & DevOps / reliability" mandate: verification repair.`;

  return await authorSpecRowStructured(
    workspaceId,
    repair.spec_slug,
    { title: cur.title, summary: cur.summary, owner: cur.owner, parent: parentProse, why: cur.why ?? cur.title, what: cur.what ?? cur.title, blocked_by: [], autoBuild: true, phases },
    "planned",
    { intendedStatusSetBy: "mario", parentKind: "mandate", parentRef },
  );
}

/** Route a genuine Mario escalation to ADA (the platform director) as an ACTIONABLE target she can fix —
 *  not a dead audit row, and NEVER the CEO for routine platform work. Creates a fresh `build` job for the
 *  stuck spec, parked `needs_approval` with a `reclaim_stuck_build` action. `build` routes to platform, so
 *  Ada's `enqueuePlatformDirectorJobs` sweep picks it up; `reclaim_stuck_build` is in-leash (`error_fix`) so
 *  she AUTO-APPROVES it after her read-only investigation; on approval the job resumes and rebuilds the spec
 *  on current `main` (clean branch → clean merge) — the build IS the reclaim. Ada is the reviewer+merger.
 *  Deduped: no target if a build is already in-flight / awaiting her for this spec. Best-effort. */
async function surfaceMarioEscalationToAda(
  admin: Admin,
  workspaceId: string,
  specSlug: string,
  reasoning: string,
  jobId: string,
): Promise<boolean> {
  // Dedupe: never stack a second build target when one is already queued/building/awaiting Ada.
  const { data: activeBuild } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", specSlug)
    .eq("kind", "build")
    .in("status", ["queued", "claimed", "building", "needs_approval", "queued_resume"])
    .limit(1);
  if (activeBuild && activeBuild.length > 0) return false;

  const actionId = `mario-reclaim-${Date.now()}`;
  const summary = `Reclaim & re-drive the stuck built-but-unmerged spec ${specSlug} (green: spec-test + security, but never merged). ${reasoning}`.slice(0, 500);
  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: specSlug,
    kind: "build",
    status: "needs_approval",
    created_by: null,
    instructions: `Mario→Ada escalation (from mario job ${jobId}): reclaim the stuck built-but-unmerged spec [[${specSlug}]]. ${reasoning}`.slice(0, 4000),
    pending_actions: [{ id: actionId, type: "reclaim_stuck_build", status: "pending", spec_slug: specSlug, summary }],
  });
  if (error) throw new Error(error.message);
  return true;
}

/**
 * `applyBoxMario` — the ONLY mutator for a Mario verdict. Reads `MARIO_AUTONOMY_MODE`, enforces
 * atomic claim-guard + loop-guard, executes one vocabulary action, optionally authors a critical
 * fix-spec, optionally widens the SLA, and records the `mario_fired` audit row. Never throws —
 * on any exception the runner's fail-safe path stamps the job.
 *
 * Mode contract:
 *  - `live` (default) — every valid verdict runs through the vocabulary switch + optional fix-spec + widen.
 *  - `surface_only` — a `live_fix` present is DEGRADED to escalate; the mutator STILL records the
 *    `mario_fired` audit row (with `mode='surface_only'` in metadata) but performs NO mutation.
 *  - `off` — the cron doesn't spawn a session; if a session STILL fires this code path, we behave as
 *    `surface_only` (belt-and-suspenders — the applier is the last gate before a write).
 *
 * Loop-guard: `PRIOR_MARIO_FIXES_FOR_SLUG` counts `mario_fixed` director_activity rows for THIS spec_slug
 * in the last 24h. At ≥ `MARIO_LOOP_GUARD_MAX` (default 3) the fix is SKIPPED and an escalation row
 * (`mario_loop_guard`) is written INSTEAD — the durable_fix_spec + threshold_adjustment paths STILL run.
 *
 * Trigger-accuracy telemetry: the audit row's `metadata` carries `trigger_accurate` + the fix outcome so
 * the Phase-4 dashboard query (`accuracy_pct`) can compute the false-trigger rate over the last 7 days.
 *
 * Self-tuning gate: a `threshold_adjustment` is applied ONLY when `trigger_accurate=false` AND the
 * adjustment's `reason` is non-empty (schema check on the payload) — an empty reason is rejected so a
 * false positive without a diagnosis can't move the SLA.
 */
export async function applyBoxMario(
  admin: Admin,
  jobId: string,
  verdict: MarioVerdict,
): Promise<ApplyBoxMarioResult> {
  try {
    const mode = readMarioAutonomyMode();

    // Read the target row — we need workspace + spec_slug for every subsequent step.
    const { data: row, error: readErr } = await admin
      .from("agent_jobs")
      .select("workspace_id, spec_slug, status")
      .eq("id", jobId)
      .maybeSingle();
    if (readErr || !row) return { ok: false, reason: "job_not_found", mode };

    // Atomic claim-guard: only ONE applyBoxMario invocation for this job wins. Mirrors
    // applyBoxDeployReview's pending-guard shape: transition claimed → building via a compare-and-set
    // + `.select('id')` so a second concurrent invocation matches zero rows and bails.
    // We accept status='building' as a already-claimed state (the runner may have set it directly) —
    // the guard's job is to serialize N concurrent appliers, not to reject a legitimate re-entry.
    const guardCheck = await admin
      .from("agent_jobs")
      .update({ status: "building", updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("workspace_id", row.workspace_id)
      .in("status", ["claimed"])
      .select("id");
    // A row already in 'building' is treated as a legitimate re-entry (no error).
    // A row in a terminal state fails the guard and we bail so we don't overwrite a completed job.
    if (row.status !== "building" && row.status !== "claimed" && (!guardCheck.data || guardCheck.data.length === 0)) {
      return { ok: false, reason: `claim_guard: row is ${row.status}`, mode };
    }

    // Loop-guard: count prior `mario_fixed` rows for THIS spec_slug in the last 24h.
    const priorFixes = await countPriorMarioFixesForSlug(admin, row.workspace_id, row.spec_slug);
    const loopGuardMax = readMarioLoopGuardMax();
    const loopGuardTriggered = priorFixes >= loopGuardMax && verdict.live_fix !== null;

    // Execute the live_fix (gated on live + not-loop-guarded + valid action).
    let fixExecuted = false;
    let fixReason: string | null = null;
    if (verdict.live_fix && mode === "live" && !loopGuardTriggered) {
      const lf = verdict.live_fix;
      try {
        switch (lf.action) {
          case "redrive_dropped_job":
            if (!lf.target.job_id) throw new Error("target.job_id required");
            await redriveDroppedJob(admin, lf.target.job_id, row.workspace_id);
            fixExecuted = true;
            break;
          case "unstick_stale_status":
            if (!lf.target.job_id) throw new Error("target.job_id required");
            await unstickStaleStatus(admin, lf.target.job_id, row.workspace_id);
            fixExecuted = true;
            break;
          case "release_cleared_blocker":
            if (!lf.target.spec_slug) throw new Error("target.spec_slug required");
            await releaseClearedBlocker(admin, row.workspace_id, lf.target.spec_slug);
            fixExecuted = true;
            break;
          case "requeue_unclaimed_job":
            if (!lf.target.job_id) throw new Error("target.job_id required");
            await requeueUnclaimedJob(admin, lf.target.job_id, row.workspace_id);
            fixExecuted = true;
            break;
          case "queue_box_restart": {
            const boxId = lf.target.box_id ?? "box";
            await queueBoxRestart(admin, boxId);
            fixExecuted = true;
            break;
          }
          case "reclaim_and_redrive":
            await reclaimAndRedrive(admin, row.workspace_id, lf.target.spec_slug ?? row.spec_slug);
            fixExecuted = true;
            break;
          default:
            fixReason = `unknown action: ${lf.action}`;
        }
      } catch (e) {
        fixReason = e instanceof Error ? e.message : String(e);
      }
    } else if (loopGuardTriggered) {
      try {
        const { recordDirectorActivity } = await import("@/lib/director-activity");
        await recordDirectorActivity(admin, {
          workspaceId: row.workspace_id,
          directorFunction: MARIO_DIRECTOR_FUNCTION,
          actionKind: "mario_loop_guard",
          specSlug: row.spec_slug,
          reason: `oscillation risk: ${priorFixes} prior mario_fixed row(s) in 24h ≥ MARIO_LOOP_GUARD_MAX=${loopGuardMax}. Live fix skipped; escalating.`,
          metadata: {
            actor: MARIO_ACTOR,
            job_id: jobId,
            prior_fixes: priorFixes,
            loop_guard_max: loopGuardMax,
            proposed_action: verdict.live_fix?.action ?? null,
            proposed_target: verdict.live_fix?.target ?? null,
          },
        });
      } catch (e) {
        console.warn("[mario] loop-guard record failed:", e instanceof Error ? e.message : e);
      }
    }

    // Fix-spec authoring — runs even when loop-guarded (the recurrence is exactly WHY the durable
    // fix-spec is proposed). Never fires in surface_only / off.
    let durableSpecAuthored = false;
    let durableSpecAuthorError: string | null = null;
    if (verdict.durable_fix_spec && mode === "live") {
      try {
        durableSpecAuthored = await authorMarioFixSpec(row.workspace_id, verdict.durable_fix_spec);
      } catch (e) {
        // LOUD, not silent: capture the failure so it surfaces on the mario_fired audit row (and Ada's
        // feed) instead of vanishing into a console.warn nobody reads. A swallowed author-write is what
        // let the same fix-spec be re-proposed every sweep with durable_spec_authored=false forever.
        durableSpecAuthorError = e instanceof Error ? e.message : String(e);
        console.warn(`[mario] fix-spec author FAILED (${verdict.durable_fix_spec.slug}): ${durableSpecAuthorError}`);
      }
    }

    // Verification repair — re-author a spec's malformed verification (promote-gate-held / loop-guard class).
    let verificationRepaired = false;
    let verificationRepairError: string | null = null;
    if (verdict.verification_repair && mode === "live") {
      try {
        verificationRepaired = await repairSpecVerification(admin, row.workspace_id, verdict.verification_repair);
      } catch (e) {
        verificationRepairError = e instanceof Error ? e.message : String(e);
        console.warn(`[mario] verification repair FAILED (${verdict.verification_repair.spec_slug}): ${verificationRepairError}`);
      }
    }

    // Threshold self-tune — Phase 3 gate: only when trigger_accurate=false AND reason is non-empty.
    let thresholdWidened = false;
    if (
      verdict.threshold_adjustment &&
      verdict.trigger_accurate === false &&
      verdict.threshold_adjustment.reason.trim().length > 0 &&
      mode === "live"
    ) {
      try {
        thresholdWidened = await widenMarioThreshold(admin, row.workspace_id, verdict.threshold_adjustment);
      } catch (e) {
        console.warn("[mario] threshold widen failed:", e instanceof Error ? e.message : e);
      }
    }

    // Escalation → ADA. When Mario escalates AND applied no live fix (a real "beyond me" call — e.g. a
    // green PR that needs a review-and-merge decision, a spec wedged in a way outside his vocabulary),
    // surface it to Ada (platform), NOT the CEO and NOT a dead audit row. Now that `reclaim_and_redrive`
    // lets him self-service the built-but-unmerged class, a true escalation is rare — but when it happens
    // it reaches his supervisor.
    let escalatedToAda = false;
    if (verdict.escalate && !fixExecuted && !verificationRepaired && mode === "live") {
      try {
        escalatedToAda = await surfaceMarioEscalationToAda(admin, row.workspace_id, row.spec_slug, verdict.reasoning ?? "", jobId);
      } catch (e) {
        console.warn("[mario] escalate-to-Ada surface failed:", e instanceof Error ? e.message : e);
      }
    }

    // Trigger-accuracy record — the query `mario_fired.metadata->>'trigger_accurate'` powers the
    // Phase-4 accuracy dashboard. Emitted on EVERY invocation regardless of mode.
    const { recordDirectorActivity } = await import("@/lib/director-activity");
    const rec = await recordDirectorActivity(admin, {
      workspaceId: row.workspace_id,
      directorFunction: MARIO_DIRECTOR_FUNCTION,
      actionKind: "mario_fired",
      specSlug: row.spec_slug,
      reason: (verdict.reasoning || "(no reasoning)").slice(0, 4000),
      metadata: {
        actor: MARIO_ACTOR,
        trigger_accurate: verdict.trigger_accurate,
        live_fix_action: verdict.live_fix?.action ?? null,
        live_fix_target: verdict.live_fix?.target ?? null,
        durable_fix_spec_slug: verdict.durable_fix_spec?.slug ?? null,
        threshold_adjustment: verdict.threshold_adjustment ?? null,
        escalate: verdict.escalate,
        escalated_to_ada: escalatedToAda,
        job_id: jobId,
        mode,
        fix_executed: fixExecuted,
        fix_reason: fixReason,
        durable_spec_authored: durableSpecAuthored,
        durable_spec_author_error: durableSpecAuthorError,
        verification_repaired: verificationRepaired,
        verification_repair_error: verificationRepairError,
        threshold_widened: thresholdWidened,
        loop_guard_triggered: loopGuardTriggered,
      },
    });

    // On a successful live_fix, record `mario_fixed` — this row is what the loop-guard's 24h count
    // consumes on the NEXT invocation. Separate action_kind so the trigger-accuracy query
    // (`mario_fired.metadata->>'trigger_accurate'`) never conflates a fix with a fire.
    if (fixExecuted) {
      try {
        await recordDirectorActivity(admin, {
          workspaceId: row.workspace_id,
          directorFunction: MARIO_DIRECTOR_FUNCTION,
          actionKind: "mario_fixed",
          specSlug: row.spec_slug,
          reason: (verdict.live_fix?.reasoning ?? "").slice(0, 4000),
          metadata: {
            actor: MARIO_ACTOR,
            job_id: jobId,
            action: verdict.live_fix?.action ?? null,
            target: verdict.live_fix?.target ?? null,
          },
        });
      } catch (e) {
        console.warn("[mario] mario_fixed record failed:", e instanceof Error ? e.message : e);
      }
    }

    // Complete the job — compare-and-set so a concurrent stamp (fail-safe / stale-session reaper)
    // never regresses a terminal status.
    try {
      await admin
        .from("agent_jobs")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .in("status", ["building", "claimed"]);
    } catch (e) {
      console.warn("[mario] job complete-stamp failed:", e instanceof Error ? e.message : e);
    }

    return {
      ok: true,
      recorded: rec.recorded,
      fix_executed: fixExecuted,
      fix_reason: fixReason ?? undefined,
      durable_spec_authored: durableSpecAuthored,
      threshold_widened: thresholdWidened,
      loop_guard_triggered: loopGuardTriggered,
      mode,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The M3 migration's seeded defaults — the fallback pre-widen sla_ms when a revert caller doesn't
 * carry the prior value (the widened row itself only stores the CURRENT sla_ms + last_widened_at +
 * reason; the pre-widen value is derived from the seed). Mirrors the values in
 * supabase/migrations/20261004120000_mario_thresholds.sql.
 */
export const MARIO_SEEDED_DEFAULT_SLA_MS: Record<string, number> = {
  "build_done|phase_shipped": 1_800_000,
  "review_started|review_passed": 1_200_000,
  "spec_test_started|spec_test_verdict": 1_800_000,
  "fold_started|folded": 1_200_000,
  "job_queued|job_claimed": 600_000,
  "phase_shipped|build_started": 1_800_000,
};

/** Look up the seeded default sla_ms for a (from_event, to_event) pair; null when unknown. */
export function marioSeededDefaultSlaMs(from_event: string, to_event: string): number | null {
  return MARIO_SEEDED_DEFAULT_SLA_MS[`${from_event}|${to_event}`] ?? null;
}

/**
 * `revertMarioThreshold` — the Phase-4 revert path. Reads the current widened row and returns its
 * `sla_ms` to the provided pre-widen value (or falls back to the seeded default when the caller
 * doesn't know the prior value), clears `last_widened_at` + `last_widened_reason`, and records a
 * `mario_threshold_reverted` audit row. Compare-and-set on `(workspace, from_event, to_event)` +
 * a `last_widened_at IS NOT NULL` guard so a revert on an already-baseline row is a safe no-op.
 */
export async function revertMarioThreshold(
  admin: Admin,
  workspaceId: string,
  from_event: string,
  to_event: string,
  preWidenSlaMs: number,
  actor?: string,
): Promise<{ reverted: boolean; reason?: string }> {
  try {
    if (!Number.isFinite(preWidenSlaMs) || preWidenSlaMs <= 0) {
      return { reverted: false, reason: "invalid pre-widen sla_ms" };
    }
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await admin
      .from("mario_thresholds")
      .update({
        sla_ms: preWidenSlaMs,
        last_widened_at: null,
        last_widened_reason: null,
        updated_at: nowIso,
      })
      .eq("workspace_id", workspaceId)
      .eq("from_event", from_event)
      .eq("to_event", to_event)
      .not("last_widened_at", "is", null)
      .select("id");
    if (error) return { reverted: false, reason: error.message };
    const reverted = Array.isArray(updated) && updated.length > 0;
    if (reverted) {
      try {
        const { recordDirectorActivity } = await import("@/lib/director-activity");
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: MARIO_DIRECTOR_FUNCTION,
          actionKind: "mario_threshold_reverted",
          reason: `Threshold (${from_event}→${to_event}) reverted to pre-widen sla_ms=${preWidenSlaMs}`,
          metadata: {
            actor: actor ?? MARIO_ACTOR,
            from_event,
            to_event,
            pre_widen_sla_ms: preWidenSlaMs,
          },
        });
      } catch (e) {
        console.warn("[mario] revert audit write failed:", e instanceof Error ? e.message : e);
      }
    }
    return { reverted, reason: reverted ? undefined : "no widened row to revert" };
  } catch (e) {
    return { reverted: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `readMarioAccuracy` — the Phase-4 accuracy probe. Reads every `mario_fired` director_activity row
 * for the workspace in the last N days (default 7) and computes the trigger-accuracy stats the
 * dashboard card + the alarm cron consume. Read-only; safe from any surface.
 */
export interface MarioAccuracyStats {
  window_days: number;
  fired_count: number;
  trigger_accurate_count: number;
  trigger_inaccurate_count: number;
  accuracy_pct: number | null; // null when fired_count=0 (avoid divide-by-zero visual noise)
}

export async function readMarioAccuracy(
  admin: Admin,
  workspaceId: string,
  windowDays: number = 7,
): Promise<MarioAccuracyStats> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("director_activity")
    .select("metadata")
    .eq("workspace_id", workspaceId)
    .eq("action_kind", "mario_fired")
    .gte("created_at", since);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ metadata: unknown }>;
  let accurate = 0;
  let inaccurate = 0;
  for (const r of rows) {
    const md = (r.metadata ?? {}) as Record<string, unknown>;
    if (md.trigger_accurate === true) accurate++;
    else if (md.trigger_accurate === false) inaccurate++;
  }
  const fired = rows.length;
  const decisions = accurate + inaccurate;
  const accuracy_pct = decisions === 0 ? null : Math.round((accurate / decisions) * 1000) / 10;
  return {
    window_days: windowDays,
    fired_count: fired,
    trigger_accurate_count: accurate,
    trigger_inaccurate_count: inaccurate,
    accuracy_pct,
  };
}

/**
 * `readMarioWidenedThresholds` — the Phase-4 dashboard card's widened-rows table source. Lists the
 * mario_thresholds rows whose `last_widened_at` is populated so a human can audit a widen +
 * one-click revert it.
 */
export interface MarioWidenedRow {
  id: string;
  from_event: string;
  to_event: string;
  sla_ms: number;
  last_widened_at: string | null;
  last_widened_reason: string | null;
}

export async function readMarioWidenedThresholds(
  admin: Admin,
  workspaceId: string,
): Promise<MarioWidenedRow[]> {
  const { data, error } = await admin
    .from("mario_thresholds")
    .select("id, from_event, to_event, sla_ms, last_widened_at, last_widened_reason")
    .eq("workspace_id", workspaceId)
    .not("last_widened_at", "is", null)
    .order("last_widened_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Array<{
    id: string;
    from_event: string;
    to_event: string;
    sla_ms: number | string;
    last_widened_at: string | null;
    last_widened_reason: string | null;
  }>).map((r) => ({
    id: r.id,
    from_event: r.from_event,
    to_event: r.to_event,
    sla_ms: typeof r.sla_ms === "string" ? Number.parseInt(r.sla_ms, 10) : r.sla_ms,
    last_widened_at: r.last_widened_at,
    last_widened_reason: r.last_widened_reason,
  }));
}

/**
 * `failsafeStampMarioUnsure` — Phase 1 fail-safe. Fires from the runner when
 * the Max session errored, the verdict was unparseable after same-session
 * repair, or `applyBoxMario` returned `{ok:false}`. Parks the job
 * `needs_attention` with `error='mario_verdict_missing'` (compare-and-set
 * against an in-flight status so a double-invoke no-ops — mirrors the
 * `failsafeStampWatchUnsure` idempotency contract) and writes one
 * `mario_failsafe` director_activity row for the audit trail. NEVER executes
 * any live_fix (absence of judgment ≠ evidence to act).
 */
export async function failsafeStampMarioUnsure(
  admin: Admin,
  args: { jobId: string; reason: string; workspaceId?: string | null; specSlug?: string | null },
): Promise<{ stamped: boolean; reason?: string }> {
  try {
    const { data: row } = await admin
      .from("agent_jobs")
      .select("workspace_id, spec_slug, status")
      .eq("id", args.jobId)
      .maybeSingle();
    if (!row) return { stamped: false, reason: "job_not_found" };

    const { data: claimed } = await admin
      .from("agent_jobs")
      .update({
        status: "needs_attention",
        error: "mario_verdict_missing",
        log_tail: `mario fail-safe: ${args.reason}`.slice(0, 2000),
      })
      .eq("id", args.jobId)
      .in("status", ["queued", "claimed", "building"])
      .select("id");
    const stamped = Array.isArray(claimed) && claimed.length > 0;

    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      await recordDirectorActivity(admin, {
        workspaceId: args.workspaceId ?? row.workspace_id,
        directorFunction: MARIO_DIRECTOR_FUNCTION,
        actionKind: "mario_failsafe",
        specSlug: args.specSlug ?? row.spec_slug,
        reason: args.reason.slice(0, 4000),
        metadata: {
          actor: MARIO_ACTOR,
          job_id: args.jobId,
          failsafe_reason: args.reason,
          stamped,
        },
      });
    } catch (e) {
      console.warn("[mario] failsafe activity write failed:", e instanceof Error ? e.message : e);
    }
    return { stamped, reason: stamped ? undefined : "not_in_flight" };
  } catch (e) {
    return { stamped: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
