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
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { listStalledCandidates } from "@/lib/spec-timecards";
import { getSpec, getSpecBlockers, getRoadmap, type SpecCard } from "@/lib/brain-roadmap";
import { getSpec as getSpecFromDb, type SpecRow } from "@/lib/specs-table";
import {
  ACTIVE_STATUSES,
  evaluateGoalMemberBuildDispatch,
  type GoalMemberBuildDispatchResult,
} from "@/lib/agent-jobs";
import { whyDidSpecReviewFail } from "@/lib/spec-investigation";
import type { SpecPhaseCheckInput } from "@/lib/spec-phase-checks-table";

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
  /** Set ONLY on a fifth-source (Vale-review-failed, missing-blocker class) candidate:
   *  the current `specs.blocked_by` column, the raw spec body, and Vale's latest
   *  `needsFixReason` (from [[./spec-investigation]] `whyDidSpecReviewFail`). The M4
   *  agent uses this to reason about the `blocked_by_repair` verb WITHOUT re-reading
   *  the spec — mirrors how the failed-build source pre-seeds `current_job_status`.
   *  Null on every other source. */
  review_failed_context?: {
    blocked_by: string[];
    body: string;
    vale_needs_fix_reason: string | null;
  } | null;
  /** Set ONLY on the Phase-2 job/PR-scoped sources (mario-detects-job-and-pr-wedges Phase 2):
   *  the stuck-queued-build source pre-seeds `job_id` so the M4 agent's `requeue_unclaimed_job`
   *  verdict can target the exact starved row; the pr-resolve-storm source pre-seeds `pr_number`
   *  so the `cancel_pr_resolve_storm` verdict can target every parked storm row for that PR
   *  without re-scanning agent_jobs. Null on every other source. */
  job_pr_context?: {
    job_id?: string | null;
    pr_number?: number | null;
    parked_count?: number | null;
  } | null;
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

/** Grace before a Vale-review-failed / missing-verification spec is treated as a stall. Wider than the
 *  build/promote graces (60 min) so Mario never races a human who is actively re-authoring a bounced spec. */
const MARIO_REVIEW_VERIFICATION_GRACE_MS = 60 * 60 * 1000;

/**
 * FOURTH candidate source (Vale-review-failed with MISSING verification). A spec that was written to
 * `public.spec_phases` WITHOUT per-phase verification — the raw-`upsertSpec` bypass that
 * harden-spec-submission now blocks at the writer, but which produced a real backlog before the floor
 * landed — sits `vale_pass=false` in `in_review` with null `verification` columns. Vale correctly bounced
 * it (needs_fix), but no surface re-authors it: it has no build job (the failed-build source misses it) and
 * its last timecard event is a review bounce, not an open `from → to` transition (the timecard thresholds
 * miss it). This reads that exact class straight from `specs` + `spec_phases`: `vale_pass=false`, at least
 * one NON-fix phase with an empty `verification`, aged past the grace window. The caller runs these through
 * the SAME (b)/(c)/(d) drop filters, then hands the survivors to the M4 agent, whose `verification_repair`
 * verb re-authors real verification through the gate and re-opens the spec to review. Precisely scoped to
 * MISSING verification (not every needs_fix) so a spec Vale bounced for a different reason (e.g. bad parent)
 * is never mis-routed to the verification repair.
 */
async function readReviewFailedVerificationStalls(
  admin: Admin,
  workspace_id: string,
  graceMs: number,
): Promise<Array<{ workspace_id: string; spec_slug: string; age_ms: number }>> {
  const now = Date.now();
  const { data: failed, error } = await admin
    .from("specs")
    .select("id, slug, status, updated_at")
    .eq("workspace_id", workspace_id)
    .eq("vale_pass", false)
    .limit(500);
  if (error) throw error;
  const rows = (failed ?? []) as Array<{ id: string; slug: string; status: string | null; updated_at: string | null }>;
  const out: Array<{ workspace_id: string; spec_slug: string; age_ms: number }> = [];
  for (const s of rows) {
    // Terminal overrides are dropped later in (d) too, but skip early to save the phase read.
    if (s.status === "folded" || s.status === "deferred") continue;
    if (!s.updated_at) continue;
    const age = now - Date.parse(s.updated_at);
    if (age <= graceMs) continue;
    const { data: phases } = await admin
      .from("spec_phases")
      .select("verification, kind")
      .eq("spec_id", s.id);
    const realPhases = ((phases ?? []) as Array<{ verification: string | null; kind: string | null }>).filter(
      (p) => p.kind !== "fix",
    );
    if (realPhases.length === 0) continue;
    const anyMissing = realPhases.some((p) => !(p.verification && p.verification.trim()));
    if (!anyMissing) continue; // Vale bounced for a NON-verification reason → not this class.
    out.push({ workspace_id, spec_slug: s.slug, age_ms: age });
  }
  return out;
}

/**
 * Parse the `**Blocked-by:** [[slug]], [[slug]]` metadata line from a spec body — mirrors
 * [[./brain-roadmap]] `parseSpec` (the raw prerequisite parser at brain-roadmap.ts:353-361). Only
 * this exact line counts — a `[[../libraries/...]]` reference elsewhere in the body is NOT a
 * declared prerequisite. Returns a de-duped array of bare slugs (no `../specs/` prefix, no `.md`
 * suffix). Exported so the fifth-source predicate below is unit-testable.
 */
export function extractBlockedBySlugsFromBody(body: string): string[] {
  const lines = body.split(/\r?\n/);
  for (const l of lines) {
    const bm = l.match(/\*\*Blocked-by:\*\*\s*(.+?)\s*$/i);
    if (!bm) continue;
    const slugs: string[] = [];
    for (const wl of bm[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      slugs.push(wl[1].trim().replace(/^.*\//, "").replace(/\.md$/, ""));
    }
    return [...new Set(slugs)];
  }
  return [];
}

/**
 * Pure decision predicate — is this Vale-bounced spec row the fifth-source's missing-blocker
 * class? Fanned out of `readReviewFailedBlockerStalls` so the exact "surface?" logic is unit-
 * testable without a stubbed Supabase client (mirrors [[./spec-drift]] pickMergedPrFromList's
 * split of I/O from decision). Returns true ONLY when: (1) not folded/deferred, (2) aged past
 * the grace, (3) every real (kind='phase') phase has verification (COMPLEMENT of the fourth
 * source), and (4) the body's `**Blocked-by:**` line names at least one slug absent from
 * `specs.blocked_by`. Every other Vale bounce class returns false — no double-routing.
 */
export function shouldSurfaceMissingBlocker(input: {
  status: string | null;
  ageMs: number;
  graceMs: number;
  realPhases: Array<{ verification: string | null }>;
  body: string;
  blocked_by: string[];
}): boolean {
  if (input.status === "folded" || input.status === "deferred") return false;
  if (input.ageMs <= input.graceMs) return false;
  if (input.realPhases.length === 0) return false;
  // COMPLEMENT of the missing-verification class — if ANY real phase lacks verification, the
  // fourth source owns this candidate. Routing both there would double-fire.
  const anyMissingVerification = input.realPhases.some(
    (p) => !(p.verification && p.verification.trim()),
  );
  if (anyMissingVerification) return false;
  const namedPrerequisiteSlugs = extractBlockedBySlugsFromBody(input.body);
  if (namedPrerequisiteSlugs.length === 0) return false;
  const currentBlockedBy = new Set(input.blocked_by);
  return namedPrerequisiteSlugs.some((slug) => !currentBlockedBy.has(slug));
}

/**
 * FIFTH candidate source (Vale-review-failed with MISSING blocked_by). Mirror of
 * `readReviewFailedVerificationStalls` scoped to the COMPLEMENT of that verification class: a
 * spec sitting `vale_pass=false` in `in_review` whose real (kind='phase') phases ALL have
 * verification — so the fourth source correctly ignored it — but whose body's `**Blocked-by:**`
 * metadata line names a prerequisite that is ABSENT from the `specs.blocked_by` column. Vale
 * bounces this exact class (`needs_fix` — the declared blocker never made it onto the row), but
 * no surface re-authors the row: it has no build job (the failed-build source misses it) and its
 * last event is a review bounce, not an open transition (the timecard thresholds miss it). Mario's
 * Phase-2 `blocked_by_repair` verb (additive union) then re-opens it to review. Precisely scoped
 * to the missing-blocker class — a spec Vale bounced for a different reason (bad parent, mangled
 * phases, …) is NOT surfaced here, so the fifth source can never mis-route to the repair. Also
 * skips a spec with no `**Blocked-by:**` line in its body (no named prerequisite → not this class).
 */
async function readReviewFailedBlockerStalls(
  admin: Admin,
  workspace_id: string,
  graceMs: number,
): Promise<Array<{ workspace_id: string; spec_slug: string; age_ms: number; body: string; blocked_by: string[] }>> {
  const now = Date.now();
  const { data: failed, error } = await admin
    .from("specs")
    .select("id, slug, status, updated_at, blocked_by")
    .eq("workspace_id", workspace_id)
    .eq("vale_pass", false)
    .limit(500);
  if (error) throw error;
  const rows = (failed ?? []) as Array<{
    id: string;
    slug: string;
    status: string | null;
    updated_at: string | null;
    blocked_by: string[] | null;
  }>;
  const out: Array<{ workspace_id: string; spec_slug: string; age_ms: number; body: string; blocked_by: string[] }> = [];
  for (const s of rows) {
    if (!s.updated_at) continue;
    const age = now - Date.parse(s.updated_at);
    const { data: phases } = await admin
      .from("spec_phases")
      .select("verification, kind")
      .eq("spec_id", s.id);
    const realPhases = ((phases ?? []) as Array<{ verification: string | null; kind: string | null }>)
      .filter((p) => p.kind !== "fix")
      .map((p) => ({ verification: p.verification }));
    // public.specs has never carried a `body` column — the raw spec markdown is reconstructed from
    // spec_phases by brain-roadmap.getSpec, which is the SAME string parseSpec used to populate
    // specs.blocked_by. Comparing against that authoritative source is the whole point of this
    // fifth-source detector — see [[../../docs/brain/libraries/mario.md]].
    const spec = await getSpec(s.slug, workspace_id);
    const body = spec?.raw ?? "";
    const blockedBy = s.blocked_by ?? [];
    if (!shouldSurfaceMissingBlocker({ status: s.status, ageMs: age, graceMs, realPhases, body, blocked_by: blockedBy })) continue;
    out.push({ workspace_id, spec_slug: s.slug, age_ms: age, body, blocked_by: blockedBy });
  }
  return out;
}

/** Grace before a planned+auto_build spec that has NO build job is treated as a stall. Wider than the
 *  failed/promote graces (60 min) so Mario never races the roadmap enqueue path or a human who just
 *  authored the spec — an enqueue attempt should have landed inside this window if the pipeline is
 *  healthy. Mirrors `MARIO_REVIEW_VERIFICATION_GRACE_MS`. */
const MARIO_ELIGIBLE_NEVER_ENQUEUED_GRACE_MS = 60 * 60 * 1000;

/** Batch size for the eligible-never-enqueued source's `.in('spec_slug', …)` build-existence scan.
 *  A single unchunked `.in()` blows past the PostgREST URL/param length ceiling once a workspace
 *  has enough auto_build slugs (each slug is a ~40-80 char kebab-case string, so ~200 comfortably
 *  fits under the 4KB default cap while keeping the round-trip count small). 200 is the same batch
 *  size the [[./ad-avatar-proposals]] `batchedIn` helper uses for the same PostgREST-URL reason. */
export const MARIO_BUILD_SCAN_IN_CHUNK = 200;

/** Chunk + fold the eligible-never-enqueued source's build-existence scan into a set of slugs that
 *  DO have a `kind='build'` row. Two named-invariant properties (pinned by
 *  `mario.eligible-never-enqueued.test.ts`):
 *   (1) CHUNKED — the `scan` callback is called with slices of at most `MARIO_BUILD_SCAN_IN_CHUNK`
 *       so a workspace with hundreds of auto_build slugs never blows past the PostgREST URL/param
 *       length ceiling.
 *   (2) FAIL-LOUD — any per-batch `error` is THROWN, never silently treated as "no build exists"
 *       (the swallow that let every aged auto_build spec workspace-wide look like a never-enqueued
 *       stall — the three hourly false-fires this spec was authored to end).
 *  Pure fold — no admin coupling; the caller injects the PostgREST scan (or a stub for testing). */
export async function foldSlugsWithBuild(
  scan: (batch: string[]) => Promise<{
    data: Array<{ spec_slug: string | null }> | null;
    error: unknown;
  }>,
  slugs: string[],
  chunkSize: number = MARIO_BUILD_SCAN_IN_CHUNK,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (slugs.length === 0) return out;
  for (let i = 0; i < slugs.length; i += chunkSize) {
    const slice = slugs.slice(i, i + chunkSize);
    const { data, error } = await scan(slice);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.spec_slug && row.spec_slug.length > 0) out.add(row.spec_slug);
    }
  }
  return out;
}

/**
 * Pure decision predicate — is this spec row the sixth-source's eligible-never-enqueued class?
 * Fanned out of `readEligibleNeverEnqueuedStalls` so the exact "surface?" logic is unit-testable
 * without a stubbed Supabase client (mirrors [[shouldSurfaceMissingBlocker]] +
 * [[isGoalMemberAwaitingPromotion]]'s split of I/O from decision). Returns true ONLY when:
 * (1) `auto_build` is true, (2) the stored status is NOT a terminal override (folded/deferred),
 * (3) it has NO row in `agent_jobs` with `kind='build'` for this slug (active OR terminal — a
 * completed/failed build means the failed-build source or the shipped state owns it), and
 * (4) it is aged past the grace window. Blocker state is deliberately NOT checked here — the
 * step-(b) `getSpecBlockers` drop in `evaluateStalledSpecs` runs on every surviving candidate
 * and handles the uncleared-blocker case uniformly across every source.
 */
export function shouldSurfaceEligibleNeverEnqueued(input: {
  status: string | null;
  autoBuild: boolean;
  hasAnyBuildJob: boolean;
  ageMs: number;
  graceMs: number;
}): boolean {
  if (!input.autoBuild) return false;
  if (input.status === "folded" || input.status === "deferred") return false;
  if (input.status === "shipped") return false;
  if (input.hasAnyBuildJob) return false;
  if (input.ageMs <= input.graceMs) return false;
  return true;
}

/**
 * SIXTH candidate source (eligible-never-enqueued keystone). A spec sitting `auto_build=true` with
 * every declared blocker shipped but NO build job on it — the most damaging wedge, because it strands
 * every downstream dependent (the 2026-07-15 overnight sweep: the rubric keystone froze 8 downstream
 * specs). Emits NO timecard signal (the roadmap enqueue never happened, so no `build_started` event to
 * open a gap), NO failed-build signal (there is no failed row — there is no row at all), and NO Vale
 * bounce (Vale passed cleanly). This reads the eligibility signal straight from `specs` + a single
 * `agent_jobs` scan: `auto_build=true`, status not folded/deferred/shipped, no `kind='build'` row for
 * the slug, aged past the grace window. The caller runs these through the SAME (b)/(c)/(d) drop
 * filters — the (b) `getSpecBlockers` drop handles the uncleared-blocker case for us, so this source
 * intentionally does NOT re-check blocker state (any blocker check drift would silently mis-surface).
 * Survivors flow through the M4 agent, whose existing `reclaim_and_redrive` verb enqueues the missing
 * build via `queueRoadmapBuild` (owner-gated, blocker-gated, active-build-gated — every safety rail
 * that owns "should this build fire" still applies).
 */
async function readEligibleNeverEnqueuedStalls(
  admin: Admin,
  workspace_id: string,
  graceMs: number,
): Promise<Array<{ workspace_id: string; spec_slug: string; age_ms: number }>> {
  const now = Date.now();
  const { data: specs, error } = await admin
    .from("specs")
    .select("slug, status, auto_build, updated_at")
    .eq("workspace_id", workspace_id)
    .eq("auto_build", true)
    .limit(1000);
  if (error) throw error;
  const rows = (specs ?? []) as Array<{
    slug: string;
    status: string | null;
    auto_build: boolean;
    updated_at: string | null;
  }>;
  if (rows.length === 0) return [];

  // Scan every build row across the candidate slugs — chunked + fail-loud on any per-batch error
  // via [[foldSlugsWithBuild]] so a workspace with hundreds of auto_build specs never blows past
  // the PostgREST URL/param length ceiling (the ceiling that previously errored silently and read
  // as "no build exists", surfacing every aged auto_build spec workspace-wide as a false-positive
  // never-enqueued stall — three hourly false-fires on the same spec before this fix).
  const slugs = rows.map((r) => r.slug);
  const slugsWithBuild = await foldSlugsWithBuild(
    (batch) =>
      admin
        .from("agent_jobs")
        .select("spec_slug")
        .eq("workspace_id", workspace_id)
        .eq("kind", "build")
        .in("spec_slug", batch) as unknown as Promise<{
          data: Array<{ spec_slug: string | null }> | null;
          error: unknown;
        }>,
    slugs,
  );

  const out: Array<{ workspace_id: string; spec_slug: string; age_ms: number }> = [];
  for (const s of rows) {
    if (!s.updated_at) continue;
    const age = now - Date.parse(s.updated_at);
    const surfaced = shouldSurfaceEligibleNeverEnqueued({
      status: s.status,
      autoBuild: s.auto_build,
      hasAnyBuildJob: slugsWithBuild.has(s.slug),
      ageMs: age,
      graceMs,
    });
    if (!surfaced) continue;
    out.push({ workspace_id, spec_slug: s.slug, age_ms: age });
  }
  return out;
}

/** Grace before a queued build with no claim is treated as a stall. A build normally claims within seconds
 *  of enqueue; a build sitting `queued` past this window with `claimed_at IS NULL` is a lane wedge (no
 *  worker picked it up: the worker restarted mid-poll, the concurrency cap starved it, or the enqueue
 *  raced with a shutdown). 45 min is well past the polling interval + normal claim latency, and past the
 *  20 min `MARIO_FAILED_BUILD_GRACE_MS` so it never front-runs the failed-build source. */
const MARIO_STUCK_QUEUED_BUILD_GRACE_MS = 45 * 60 * 1000;

/**
 * Pure decision predicate — is this build row the seventh-source's stuck-queued-unclaimed class?
 * Fanned out of `readStuckQueuedBuildStalls` so the exact "surface?" logic is unit-testable
 * without a stubbed Supabase client. Returns true ONLY when: (1) status is `queued` (a starved
 * enqueue, not a mid-flight build — `redrive_dropped_job` owns the `building`/`claimed` class),
 * (2) `claimed_at` is null (no worker has ever touched it — a re-queued row that got claimed
 * once but rolled back is a different class), and (3) it is aged past the grace window.
 * The 45-min grace is comfortably past the failed-build source's 20-min grace so a wedge
 * that later flips to `failed` is caught by the failed-build source first (no double-fire).
 */
export function shouldSurfaceStuckQueuedBuild(input: {
  status: string;
  claimedAt: string | null;
  ageMs: number;
  graceMs: number;
}): boolean {
  if (input.status !== "queued") return false;
  if (input.claimedAt !== null) return false;
  if (input.ageMs <= input.graceMs) return false;
  return true;
}

/**
 * SEVENTH candidate source (stuck-queued-build lane wedge). A build sitting `status='queued'` for hours
 * with `claimed_at IS NULL` — no worker ever picked it up — emits no failed-build signal (there is no
 * `failed` row), no timecard gap (the enqueue landed, so `build_queued` fired, but nothing progressed),
 * and no Vale signal. Overnight 2026-07-15 the rubric keystone's build sat queued for 7.9h before Mario
 * (spec-lifecycle-only eyes) noticed nothing. This reads the wedge signal straight from `agent_jobs`:
 * `kind='build' AND status='queued' AND claimed_at IS NULL AND created_at < now - grace`. The caller
 * runs these through the SAME (b)/(c)/(d) drop filters, then hands the survivor to the M4 agent, whose
 * existing `requeue_unclaimed_job` verb flips `updated_at` so the next poll re-picks it. If the requeue
 * is a no-op (the queue drained itself in the meantime), the verb throws and the applier records the
 * reason on the mario_fired row → the escalate path can then surface to Ada.
 */
async function readStuckQueuedBuildStalls(
  admin: Admin,
  workspace_id: string,
  graceMs: number,
): Promise<Array<{ workspace_id: string; spec_slug: string; job_id: string; age_ms: number }>> {
  const now = Date.now();
  const cutoff = new Date(now - graceMs).toISOString();
  const { data, error } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, claimed_at, created_at")
    .eq("workspace_id", workspace_id)
    .eq("kind", "build")
    .eq("status", "queued")
    .is("claimed_at", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    spec_slug: string | null;
    status: string;
    claimed_at: string | null;
    created_at: string;
  }>;
  const out: Array<{ workspace_id: string; spec_slug: string; job_id: string; age_ms: number }> = [];
  for (const j of rows) {
    if (!j.spec_slug || !j.created_at) continue;
    const age = now - Date.parse(j.created_at);
    if (
      !shouldSurfaceStuckQueuedBuild({
        status: j.status,
        claimedAt: j.claimed_at,
        ageMs: age,
        graceMs,
      })
    ) continue;
    out.push({ workspace_id, spec_slug: j.spec_slug, job_id: j.id, age_ms: age });
  }
  return out;
}

/** Minimum parked-count in the pr-resolve storm window before a PR is treated as storming. 3 rows
 *  in the window means the resolver keeps running and keeps landing in a non-terminal `needs_attention`
 *  or `failed` state — the retry-cap surface in [[github-pr-resolve]] `surfaceExhaustedPrResolve`
 *  already stamps a single `needs_attention` sentinel per PR, so 3 rows means Mario is looking at a
 *  repeat pattern the deduper alone did not stop. */
/** Orphaned-PR detector age ceiling: only a build row updated within this window is considered for an
 *  orphaned open PR. A genuinely orphaned PR is days-old at most; older `completed` rows are settled
 *  history (pre-`merged`-status convention) and must never be re-litigated (911 2026-07-16). */
const MARIO_ORPHANED_PR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MARIO_PR_RESOLVE_STORM_MIN_PARKED = 3;

/** Rolling window Mario looks back to count parked pr-resolve rows for one PR. 24 h is wide enough to
 *  catch an overnight storm (2026-07-15: 61 rows over ~8 h) but narrow enough not to conflate today's
 *  storm with a stale one from a week ago. */
const MARIO_PR_RESOLVE_STORM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pure decision predicate — is this pr_number's parked-count in the window enough to be a storm?
 * Fanned out of `readPrResolveStorms` so the exact "surface?" logic is unit-testable without any
 * Supabase stub. Returns true ONLY when the parked count meets or exceeds the minimum (the min gate
 * lives in the predicate so a caller can pin the exact boundary the deployed cron uses).
 */
export function shouldSurfacePrResolveStorm(input: {
  parkedCount: number;
  minCount: number;
}): boolean {
  return input.parkedCount >= input.minCount;
}

/**
 * EIGHTH candidate source (pr-resolve storm — a single PR's parked resolver rows piling up). The
 * dirty-PR resolver at [[github-pr-resolve]] re-enqueues on each webhook, but a PR that keeps
 * conflicting (or a resolver that keeps landing in `needs_attention`) accumulates dozens of parked
 * rows per PR — 2026-07-15 overnight: 61 rows for one PR over ~8 h. Each row carries a pseudo-slug
 * `pr-<number>` (no matching `public.specs` row by design), so every earlier source misses it AND
 * the `!specRow` drop at (d0) discards a job/PR candidate anyway. This reads the storm signal
 * straight from `agent_jobs`: `kind='pr-resolve' AND status IN ('needs_attention','failed') AND
 * created_at > now - window`, grouped by `pr_number`. A pr_number with `≥ MARIO_PR_RESOLVE_STORM_MIN_PARKED`
 * parked rows is surfaced with the pseudo-slug (`pr-<number>`) as the candidate's `spec_slug`. Survivors
 * flow through the SAME (b)/(c) drop filters (both are safe for a pseudo-slug — no blockers, no active
 * job under this slug once the storm parks), skip the specRow gate (relaxed at (d0) for job/PR-scoped
 * candidates), and reach the M4 agent, whose new `cancel_pr_resolve_storm` verb flips every parked
 * row to `completed` with a cancellation reason — the deduper's active-row guard then lets a fresh
 * resolve enqueue on the next webhook without a phantom pile.
 */
async function readPrResolveStorms(
  admin: Admin,
  workspace_id: string,
  windowMs: number,
  minCount: number,
): Promise<Array<{ workspace_id: string; spec_slug: string; pr_number: number; parked_count: number; age_ms: number }>> {
  const now = Date.now();
  const cutoff = new Date(now - windowMs).toISOString();
  const { data, error } = await admin
    .from("agent_jobs")
    .select("pr_number, status, created_at")
    .eq("workspace_id", workspace_id)
    .eq("kind", "pr-resolve")
    .in("status", ["needs_attention", "failed"])
    .gte("created_at", cutoff)
    .not("pr_number", "is", null)
    .limit(5000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    pr_number: number | null;
    status: string;
    created_at: string;
  }>;
  const byPr = new Map<number, { count: number; oldest: number }>();
  for (const r of rows) {
    if (r.pr_number === null || !r.created_at) continue;
    const at = Date.parse(r.created_at);
    const cur = byPr.get(r.pr_number);
    if (cur) {
      cur.count += 1;
      if (at < cur.oldest) cur.oldest = at;
    } else {
      byPr.set(r.pr_number, { count: 1, oldest: at });
    }
  }
  const out: Array<{ workspace_id: string; spec_slug: string; pr_number: number; parked_count: number; age_ms: number }> = [];
  for (const [prNumber, agg] of byPr) {
    if (!shouldSurfacePrResolveStorm({ parkedCount: agg.count, minCount })) continue;
    out.push({
      workspace_id,
      spec_slug: `pr-${prNumber}`, // pseudo-slug: matches [[github-pr-resolve]] `prSpecSlug`
      pr_number: prNumber,
      parked_count: agg.count,
      age_ms: now - agg.oldest,
    });
  }
  return out;
}

/**
 * The set of `from_event` values marking a Phase-2 job/PR-scoped candidate — these carry a pseudo
 * spec_slug that has no `public.specs` row by design (pr-resolve storms use `pr-<number>`; a stuck
 * queued build uses a real slug but is included here for symmetry so the (d0) relax covers both).
 * The (d0) `!specRow` drop is relaxed for candidates in this set so the phantom-guard no longer
 * discards a genuine job/PR wedge (the drop was designed for phantom spec-lifecycle candidates from
 * a failed authorship — a wedge with no spec is DIFFERENT semantics, not a phantom).
 */
const JOB_PR_SCOPED_FROM_EVENTS: ReadonlySet<string> = new Set(["build_queued", "pr_resolve_storm"]);

/**
 * The set of `from_event` values whose whole point is a TERMINAL spec (folded/shipped) with an open
 * PR — the ninth-source's class (mario-detects-job-and-pr-wedges Phase 3). The (d) folded/deferred
 * drop is relaxed for these so a genuinely-terminal spec with a still-open orphaned PR survives to
 * `applyBoxMario`, where the `close_orphaned_pr` verb closes the PR + deletes the branch through
 * `closeDuplicatePr`. Kept as a small opt-in set so the drop's default remains fail-safe: a folded
 * spec that surfaced under any OTHER from_event (e.g. a stale timecard event) is still dropped.
 */
const TERMINAL_OK_FROM_EVENTS: ReadonlySet<string> = new Set(["orphaned_folded_pr"]);

/**
 * Pure decision predicate — is this build row the ninth-source's orphaned-folded-PR class?
 * Fanned out of `readOrphanedFoldedPrs` so the exact "surface?" logic is unit-testable without a
 * stubbed Supabase client (mirrors [[shouldSurfacePrResolveStorm]] +
 * [[shouldSurfaceStuckQueuedBuild]]'s split of I/O from decision). Returns true ONLY when:
 * (1) the spec's stored status is `folded` OR `shipped` (a terminal override — the PR should not be
 *     open anymore; a `planned`/`in_progress`/`in_review`/`deferred` spec has a genuine reason for
 *     its PR to stay open), AND
 * (2) the build row's status is NOT `merged` (a merged build had its PR merged on GitHub, so there
 *     is nothing to close). Other build statuses (completed / needs_attention / failed / queued /
 *     claimed / building) can all leave an open PR behind on a folded spec — we surface all of them.
 */
export function shouldSurfaceOrphanedFoldedPr(input: {
  specStatus: string | null;
  buildJobStatus: string;
}): boolean {
  if (input.specStatus !== "folded" && input.specStatus !== "shipped") return false;
  if (input.buildJobStatus === "merged") return false;
  return true;
}

/**
 * NINTH candidate source (orphaned folded/shipped-spec open PR). PR #1893 sat open + conflicting for
 * 7 h before Mario noticed nothing — the spec had folded, but no detector caught the orphaned PR
 * (the ultimate cause of the pr-resolve storm Phase 2 handles: a superseded PR that kept re-firing
 * the resolver). This reads the class straight from `agent_jobs` + `specs`: `kind='build' AND
 * pr_number IS NOT NULL AND status NOT IN ('merged')`, cross-referenced with `specs.status IN
 * ('folded','shipped')`. Survivors flow through the SAME (b)/(c)/(d) drop filters — (d) is relaxed
 * via `TERMINAL_OK_FROM_EVENTS` for THIS from_event so the folded/shipped drop doesn't front-run.
 * The M4 agent's `close_orphaned_pr` verb re-confirms the spec is still terminal + closes the PR
 * via [[github-pr-resolve]] `closeDuplicatePr` (with a mario-branded comment + branch delete).
 */
async function readOrphanedFoldedPrs(
  admin: Admin,
  workspace_id: string,
): Promise<Array<{ workspace_id: string; spec_slug: string; pr_number: number; branch: string | null; age_ms: number }>> {
  const now = Date.now();
  // AGE CEILING (911 fix `mario-orphaned-pr-age-ceiling` 2026-07-16): only consider RECENT build rows.
  // The detector's real job is catching a just-folded spec whose PR is still open (e.g. #1893 at 7h) —
  // NOT months-old settled PRs. Ancient `completed` build rows (pre-`merged`-status convention, e.g.
  // June PRs #1216/#1218) have no `merged` sibling for the #1914 dedupe to catch, so they re-surfaced as
  // false orphans and mass-enqueued ~99 no-op mario jobs every cron tick. A genuinely orphaned PR is
  // days-old at most; cap at MARIO_ORPHANED_PR_MAX_AGE_MS so settled history is never re-litigated.
  const orphanCutoff = new Date(now - MARIO_ORPHANED_PR_MAX_AGE_MS).toISOString();
  const { data: builds, error } = await admin
    .from("agent_jobs")
    .select("spec_slug, pr_number, spec_branch, status, updated_at")
    .eq("workspace_id", workspace_id)
    .eq("kind", "build")
    .not("pr_number", "is", null)
    .neq("status", "merged")
    .gte("updated_at", orphanCutoff)
    .limit(1000);
  if (error) throw error;
  const rows = (builds ?? []) as Array<{
    spec_slug: string | null;
    pr_number: number | null;
    spec_branch: string | null;
    status: string;
    updated_at: string | null;
  }>;
  if (rows.length === 0) return [];

  // Newest row per spec_slug wins so a folded spec with N historical builds doesn't fan out into N
  // orphan candidates (only the most recent PR/branch is the one still open on GitHub in practice).
  const bySlug = new Map<string, { pr_number: number; spec_branch: string | null; status: string; updated_at: string | null }>();
  for (const b of rows) {
    if (!b.spec_slug || b.pr_number == null) continue;
    const cur = bySlug.get(b.spec_slug);
    const curUpd = cur?.updated_at ? Date.parse(cur.updated_at) : 0;
    const newUpd = b.updated_at ? Date.parse(b.updated_at) : 0;
    if (!cur || newUpd > curUpd) {
      bySlug.set(b.spec_slug, { pr_number: b.pr_number, spec_branch: b.spec_branch, status: b.status, updated_at: b.updated_at });
    }
  }
  if (bySlug.size === 0) return [];

  const slugs = [...bySlug.keys()];
  const { data: specs } = await admin
    .from("specs")
    .select("slug, status")
    .eq("workspace_id", workspace_id)
    .in("slug", slugs)
    .in("status", ["folded", "shipped"]);
  const terminalSpecs = new Map<string, string>();
  for (const s of ((specs ?? []) as Array<{ slug: string; status: string | null }>)) {
    if (s.status === "folded" || s.status === "shipped") terminalSpecs.set(s.slug, s.status);
  }

  // A PR that has ANY build row already `merged` is NOT orphaned — it merged via a DIFFERENT build
  // row for the same PR. The primary scan above excludes `merged` rows (`.neq('status','merged')`), so
  // a PR with an earlier `completed`/`needs_attention` build row (same pr_number) survives as a FALSE
  // orphan and re-enqueues a mario job every cron tick (911 2026-07-16: ~24 long-merged PRs like #868 —
  // a `merged` build row AND a `completed` build row both carry pr_number=868 — mass-enqueued mario jobs
  // that just no-op on the already-closed PR). Fetch the merged pr_numbers among our candidates and drop them.
  const candidatePrs = [...new Set([...bySlug.values()].map((b) => b.pr_number))];
  const { data: mergedRows } = candidatePrs.length
    ? await admin
        .from("agent_jobs")
        .select("pr_number")
        .eq("workspace_id", workspace_id)
        .eq("kind", "build")
        .eq("status", "merged")
        .in("pr_number", candidatePrs)
    : { data: [] as Array<{ pr_number: number | null }> };
  const mergedPrs = new Set(((mergedRows ?? []) as Array<{ pr_number: number | null }>).map((r) => r.pr_number));

  const out: Array<{ workspace_id: string; spec_slug: string; pr_number: number; branch: string | null; age_ms: number }> = [];
  for (const [slug, b] of bySlug) {
    if (mergedPrs.has(b.pr_number)) continue; // PR already merged (a sibling build row is `merged`) — not orphaned
    const specStatus = terminalSpecs.get(slug) ?? null;
    if (
      !shouldSurfaceOrphanedFoldedPr({
        specStatus,
        buildJobStatus: b.status,
      })
    ) continue;
    const ageMs = b.updated_at ? now - Date.parse(b.updated_at) : 0;
    out.push({ workspace_id, spec_slug: slug, pr_number: b.pr_number, branch: b.spec_branch, age_ms: ageMs });
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
 *  (d2) DROPS a goal member whose build is integrated on `goal/<goalSlug>` and whose
 *      goal has NOT yet atomically promoted (`goals.main_merge_sha` null) — its
 *      integration target is the goal branch, not `main`, so the ledger's silence is
 *      the promotion gate's job, not Mario's. Removes the `mario_fired` row + the
 *      loop-guard oscillation risk that Phase 1's applier-level catch still accrued.
 *  (d3) DROPS an eligible-never-enqueued goal member (sixth source only) whose goal
 *      build-dispatch serializer is legitimately holding it — a conflicting goal-mate
 *      build is in-flight, so this member correctly has no build job and correctly
 *      ages past the grace window. Same class as (d2): a legit pre-build serial wait,
 *      not a stall. See [[shouldDropSeriallyHeldGoalMember]] for the pure predicate.
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

    // (a4) FOURTH candidate source — Vale-review-failed with MISSING verification (see
    // readReviewFailedVerificationStalls). A spec authored WITHOUT per-phase verification (the raw-upsertSpec
    // bypass that harden-spec-submission now blocks at the writer) sits in_review with `vale_pass=false` and
    // null verification columns — Vale correctly bounced it, but nothing re-authors it, so it stalls
    // invisibly (no build job → the failed-build source misses it; its last event is a review bounce, not an
    // open transition → the timecard thresholds miss it). Mario's existing `verification_repair` verb re-
    // authors real per-phase verification through the gate and re-opens it to review. This source surfaces
    // that class so the M4 agent can propose the repair.
    const reviewFailed = await readReviewFailedVerificationStalls(admin, ws, MARIO_REVIEW_VERIFICATION_GRACE_MS);
    for (const rf of reviewFailed) {
      const key = `${rf.workspace_id}::${rf.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: rf.workspace_id,
        spec_slug: rf.spec_slug,
        // Semantic: review STARTED but never PASSED — Vale bounced it for missing verification and it stuck.
        from_event: "review_started",
        to_event: "review_passed",
        gap_ms: rf.age_ms,
        sla_ms: MARIO_REVIEW_VERIFICATION_GRACE_MS,
        brief: { last_events: [], blocked_by_state: [], current_job_status: "review_failed_missing_verification" },
      });
    }

    // (a5) FIFTH candidate source — Vale-review-failed with MISSING blocked_by (see
    // readReviewFailedBlockerStalls). Complementary scope to (a4): the fourth source owns specs whose
    // real phases lack verification; the fifth owns specs whose real phases DO have verification but
    // whose body's `**Blocked-by:**` line names a prerequisite absent from `specs.blocked_by`. Vale
    // bounces that class (needs_fix — declared blocker never landed on the row), but no surface re-
    // authors it. Mario's Phase-2 `blocked_by_repair` verb (additive union) does — this source
    // surfaces the class so the M4 agent can propose it. Pre-seeds `review_failed_context` on the
    // brief so a survivor already carries current blocked_by + spec body without re-reading; the
    // needsFixReason is stamped after (b)/(c)/(d) so we only pay per candidate that survives.
    const blockerFailed = await readReviewFailedBlockerStalls(admin, ws, MARIO_REVIEW_VERIFICATION_GRACE_MS);
    for (const bf of blockerFailed) {
      const key = `${bf.workspace_id}::${bf.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: bf.workspace_id,
        spec_slug: bf.spec_slug,
        // Semantic: review STARTED but never PASSED — Vale bounced it for a missing blocked_by entry.
        from_event: "review_started",
        to_event: "review_passed",
        gap_ms: bf.age_ms,
        sla_ms: MARIO_REVIEW_VERIFICATION_GRACE_MS,
        brief: {
          last_events: [],
          blocked_by_state: [],
          current_job_status: "review_failed_missing_blocker",
          review_failed_context: { blocked_by: bf.blocked_by, body: bf.body, vale_needs_fix_reason: null },
        },
      });
    }

    // (a6) SIXTH candidate source — eligible-never-enqueued keystones (see
    // readEligibleNeverEnqueuedStalls). The highest-value class: a spec `auto_build=true` with every
    // declared blocker shipped but NO build job on it strands every downstream dependent (last
    // night: the rubric keystone froze 8 specs) and emits no timecard/failed-build/Vale signal, so
    // every prior source misses it. Survivors flow through the SAME (b)/(c)/(d) drop filters and
    // then to the M4 agent, whose existing `reclaim_and_redrive` verb enqueues the missing build.
    const eligible = await readEligibleNeverEnqueuedStalls(admin, ws, MARIO_ELIGIBLE_NEVER_ENQUEUED_GRACE_MS);
    for (const en of eligible) {
      const key = `${en.workspace_id}::${en.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: en.workspace_id,
        spec_slug: en.spec_slug,
        // Semantic: the spec was AUTHORED (and passed review) but never STARTED a build — the
        // roadmap enqueue never fired, so the ledger has no `build_started` event to open a gap.
        from_event: "spec_authored",
        to_event: "build_started",
        gap_ms: en.age_ms,
        sla_ms: MARIO_ELIGIBLE_NEVER_ENQUEUED_GRACE_MS,
        brief: { last_events: [], blocked_by_state: [], current_job_status: "eligible_never_enqueued" },
      });
    }

    // (a7) SEVENTH candidate source — stuck-queued-build lane wedge (see readStuckQueuedBuildStalls).
    // A build sitting `queued` past the grace with `claimed_at IS NULL` — no worker ever picked it up —
    // emits no failed-build signal and no timecard gap. The pre-seeded `job_pr_context.job_id` lets the
    // M4 agent's `requeue_unclaimed_job` verdict target the exact starved row without re-scanning
    // agent_jobs. Deduped against the timecard / failed-build / eligible-never-enqueued sources via
    // `seen` — a spec whose stuck-queued row is already surfaced under another class does not double-fire.
    const stuck = await readStuckQueuedBuildStalls(admin, ws, MARIO_STUCK_QUEUED_BUILD_GRACE_MS);
    for (const sb of stuck) {
      const key = `${sb.workspace_id}::${sb.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: sb.workspace_id,
        spec_slug: sb.spec_slug,
        // Semantic: build_queued fired (the enqueue landed) but build_started never followed (nothing claimed).
        // The from_event is on JOB_PR_SCOPED_FROM_EVENTS so the (d0) !specRow relax applies uniformly
        // (a stuck-queued build normally has a real spec, but symmetry avoids a subtle-drift class).
        from_event: "build_queued",
        to_event: "build_started",
        gap_ms: sb.age_ms,
        sla_ms: MARIO_STUCK_QUEUED_BUILD_GRACE_MS,
        brief: {
          last_events: [],
          blocked_by_state: [],
          current_job_status: "queued_unclaimed",
          job_pr_context: { job_id: sb.job_id, pr_number: null, parked_count: null },
        },
      });
    }

    // (a8) EIGHTH candidate source — pr-resolve storm (see readPrResolveStorms). A single PR whose
    // dirty-resolver keeps parking rows in `needs_attention`/`failed` piles up dozens per PR overnight.
    // The candidate carries the pseudo-slug `pr-<number>` (no matching specs row by design), so the
    // (d0) `!specRow` gate is RELAXED for this from_event so the candidate survives. The pre-seeded
    // `job_pr_context.pr_number` + `parked_count` lets the M4 agent's `cancel_pr_resolve_storm` verdict
    // target the exact PR without re-scanning.
    const storms = await readPrResolveStorms(
      admin,
      ws,
      MARIO_PR_RESOLVE_STORM_WINDOW_MS,
      MARIO_PR_RESOLVE_STORM_MIN_PARKED,
    );
    for (const st of storms) {
      const key = `${st.workspace_id}::${st.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: st.workspace_id,
        spec_slug: st.spec_slug,
        // Semantic: pr-resolve keeps parking (needs_attention/failed) — the dirty-PR resolver is
        // storming on this PR. The from_event is on JOB_PR_SCOPED_FROM_EVENTS so the (d0) !specRow
        // relax lets the pseudo-slug candidate survive to applyBoxMario.
        from_event: "pr_resolve_storm",
        to_event: "pr_resolve_settled",
        gap_ms: st.age_ms,
        sla_ms: MARIO_PR_RESOLVE_STORM_WINDOW_MS,
        brief: {
          last_events: [],
          blocked_by_state: [],
          current_job_status: "pr_resolve_storm",
          job_pr_context: { job_id: null, pr_number: st.pr_number, parked_count: st.parked_count },
        },
      });
    }

    // (a9) NINTH candidate source — orphaned folded/shipped-spec open PR (see readOrphanedFoldedPrs).
    // PR #1893 sat open + conflicting for 7 h because its spec had folded and no detector caught it.
    // The candidate carries the REAL spec_slug (the spec exists in `public.specs` — it's just terminal),
    // pr_number + branch pre-seeded on `job_pr_context` for the M4 agent's `close_orphaned_pr` verdict.
    // The (d) folded/deferred drop is RELAXED for this from_event via TERMINAL_OK_FROM_EVENTS so the
    // terminal spec survives — this is the ONE class where a folded spec IS the target, not a drop.
    const orphans = await readOrphanedFoldedPrs(admin, ws);
    for (const orph of orphans) {
      const key = `${orph.workspace_id}::${orph.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: orph.workspace_id,
        spec_slug: orph.spec_slug,
        // Semantic: the spec IS terminal (folded/shipped) but the PR is STILL open — the merge/close
        // step that owns dropping the PR after fold never happened.
        from_event: "orphaned_folded_pr",
        to_event: "pr_closed",
        gap_ms: orph.age_ms,
        // Reuses the review-verification grace (1h) as the "how stale is the observation" pin so a
        // freshly-folded spec's PR isn't touched before the fold cleanup path has room to run.
        sla_ms: MARIO_REVIEW_VERIFICATION_GRACE_MS,
        brief: {
          last_events: [],
          blocked_by_state: [],
          current_job_status: "orphaned_folded_pr_open",
          job_pr_context: { job_id: null, pr_number: orph.pr_number, parked_count: null },
        },
      });
    }
  }

  // spec-read-eff-mario — Phase 3 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md.
  // The N+1 fix: the pre-Phase-3 loop called getSpecBlockers(slug) per candidate, and each call fires
  // a full getRoadmap() (~9 whole-board scans). One tick with M candidates and N workspaces used to
  // pay M × 9 board scans. Now: ONE getRoadmap(workspace) per unique workspace_id → build a
  // slug→blockedBy lookup, and the loop reads from that snapshot. Falls back to getSpecBlockers on a
  // per-candidate cache miss (unknown workspace / getRoadmap error) so a snapshot error can never
  // silently degrade the (b) uncleared-blocker filter — behavior-preserving.
  const boardBySlug = new Map<string, Map<string, SpecCard["blockedBy"]>>();
  const uniqueWorkspaceIds = Array.from(new Set(initial.map((c) => c.workspace_id)));
  await Promise.all(
    uniqueWorkspaceIds.map(async (wsId) => {
      try {
        const { specs } = await getRoadmap(wsId);
        const bySlug = new Map<string, SpecCard["blockedBy"]>();
        for (const s of specs) bySlug.set(s.slug, s.blockedBy);
        boardBySlug.set(wsId, bySlug);
      } catch {
        // Fail-open: leave the workspace un-snapshotted; the loop falls back to getSpecBlockers.
      }
    }),
  );

  const survivors: StalledCandidate[] = [];
  for (const c of initial) {
    // (b) uncleared blockedBy → legit wait, drop.
    // spec-read-eff-mario — read from the per-tick board snapshot when present; a workspace whose
    // snapshot failed (or a candidate whose slug isn't on the boardable set — e.g. a pr-<n> pseudo
    // slug) falls back to the per-candidate getSpecBlockers path so no candidate is ever silently
    // treated as unblocked because its slug is absent from the snapshot.
    const snapshot = boardBySlug.get(c.workspace_id);
    const blockers = snapshot?.has(c.spec_slug)
      ? snapshot.get(c.spec_slug)!
      : await getSpecBlockers(c.spec_slug);
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
    //
    // RELAX for JOB/PR-scoped candidates (mario-detects-job-and-pr-wedges Phase 2): a pr-resolve storm
    // carries a pseudo-slug `pr-<number>` that has NO matching public.specs row by design (the resolver
    // runs against a PR, not a spec); the unconditional drop discards every genuine job/PR wedge.
    // JOB_PR_SCOPED_FROM_EVENTS marks the sources whose from_event guarantees a job/PR class — those
    // candidates survive the no-specRow case, and skip the specRow-dependent (d)/(d2) filters below.
    if (!specRow) {
      if (!JOB_PR_SCOPED_FROM_EVENTS.has(c.from_event)) continue;
      // Job/PR-scoped candidate with no spec — safe to fall through to the brief-attach step (e). The
      // specRow-dependent gates below (folded/deferred, goal-member-awaiting-promotion) don't apply.
      const lastEvents = await readLastEvents(admin, c.workspace_id, c.spec_slug);
      survivors.push({
        ...c,
        brief: {
          ...c.brief,
          last_events: lastEvents,
          blocked_by_state: blockers.map((b) => ({ slug: b.slug, cleared: b.cleared })),
          current_job_status: currentJobStatus ?? c.brief.current_job_status,
        },
      });
      continue;
    }
    // RELAX for TERMINAL-TARGETED sources (mario-detects-job-and-pr-wedges Phase 3): the ninth
    // source (`orphaned_folded_pr`) EXPECTS a folded/shipped spec — that's the exact class it chases
    // (a terminal spec with a still-open PR). Skip the drop for those from_events so the terminal
    // spec survives to the M4 agent's `close_orphaned_pr` verdict. Any other from_event hitting a
    // terminal (folded / deferred / shipped) spec is still dropped fail-safe.
    //
    // 911 fix (mario-skip-shipped-specs 2026-07-16): a fully-SHIPPED spec presents with a NULL raw
    // `specRow.status` (that override column is only stamped for folded / deferred / in_review), so
    // the folded/deferred check alone does NOT catch it — Mario would fire on a long-shipped spec that
    // merely had a rough build history. A pipeline visibility increase surfaced ~50 such specs and
    // mass-enqueued mario jobs against them. Derive shipped from the phase rollup (every phase shipped)
    // and drop it under the SAME terminal-source relax as folded/deferred.
    // (d) terminal spec (folded / deferred / derived-shipped) — dropped UNLESS this from_event is a
    // terminal-targeted source (orphaned_folded_pr). The enqueue chokepoint (isMarioTerminalSpec guard in
    // enqueueMarioJob) is the ABSOLUTE backstop that refuses even the relaxed source per the CEO directive.
    if (isMarioTerminalSpec(specRow)) {
      if (!TERMINAL_OK_FROM_EVENTS.has(c.from_event)) continue;
    }

    // (d2) GOAL MEMBER AWAITING ATOMIC PROMOTION → legit wait, drop. A goal member's correct
    // integration target is its GOAL BRANCH; it only reaches `main` via M5's atomic goal→main
    // promotion. When the member's build has already merged onto goal/<goalSlug> AND the goal has
    // NOT yet atomically promoted (`goals.main_merge_sha` is null), the ledger's silence is expected
    // — the promotion gate owns driving it to main, and Mario has no honest fix. Dropping the row
    // here (source-level) means no verdict, no `mario_fired` row, no loop-guard pressure and no
    // wasted Max session — cheaper than the Phase-1 catch that only refused to reclaim, and it
    // removes the ≥3-in-24h oscillation risk that repeated firings on the same awaiting slug can
    // accrue on `MARIO_LOOP_GUARD_MAX`. Same class as folded/deferred/uncleared-blocker: a legit
    // wait, not a stall. See [[isGoalMemberAwaitingPromotion]] for the pure predicate.
    if (await isSpecRowAwaitingGoalPromotion(admin, specRow)) continue;

    // (d3) SERIALLY-HELD GOAL MEMBER (sixth source only) → legit wait, drop. An eligible-never-
    // enqueued goal member has `auto_build=true`, every blocker cleared, and no build job — but
    // the goal build-dispatch serializer admits ONE conflicting member build at a time, so a
    // waiting member correctly has no job and correctly ages past the grace window. The sixth
    // source reads that legitimate serial wait as a stall and fires Mario; each firing burns a
    // Max session and accrues oscillation-guard pressure on a spec that is behaving as designed.
    // Consult the serializer BEFORE surfacing: ok:false ⇒ drop; ok:true (one-off spec, member of
    // a different goal, or an admissible member) ⇒ keep. Scoped to `spec_authored` so the other
    // sources (failed-build, stuck-queued, pr-resolve-storm, orphaned-folded-pr, …) are untouched.
    // Fail-open on any serializer error so a transient DB fault never silently hides a real stall.
    if (c.from_event === "spec_authored") {
      try {
        const dispatch = await evaluateGoalMemberBuildDispatch(c.workspace_id, c.spec_slug);
        if (shouldDropSeriallyHeldGoalMember({ fromEvent: c.from_event, dispatch })) continue;
      } catch {
        // Fail-open — let the candidate survive to the M4 agent so a transient serializer read
        // failure cannot mask a real eligible-never-enqueued stall.
      }
    }

    // (e) fill the brief now that the candidate survived every filter.
    const lastEvents = await readLastEvents(admin, c.workspace_id, c.spec_slug);
    // (e2) For the fifth (missing-blocker) source, stamp Vale's latest needsFixReason so the M4
    // agent can cite Vale's own bounce reasoning verbatim in the blocked_by_repair proposal.
    // Only paid for a candidate that survived (b)/(c)/(d), so the cost is bounded.
    let reviewFailedCtx = c.brief.review_failed_context ?? null;
    if (reviewFailedCtx) {
      try {
        const review = await whyDidSpecReviewFail(c.workspace_id, c.spec_slug);
        reviewFailedCtx = { ...reviewFailedCtx, vale_needs_fix_reason: review.needsFixReason };
      } catch {
        // Ignore — the brief is still useful without the reason.
      }
    }
    survivors.push({
      ...c,
      brief: {
        last_events: lastEvents,
        blocked_by_state: blockers.map((b) => ({ slug: b.slug, cleared: b.cleared })),
        // Prefer a live active status; else keep the candidate's pre-seeded status (e.g. `failed` from the
        // failed-build source) so the brief never hides a dead build behind a null.
        current_job_status: currentJobStatus ?? c.brief.current_job_status,
        review_failed_context: reviewFailedCtx,
        // mario-detects-job-and-pr-wedges Phase 2: preserve the pre-seeded job/PR target context so the
        // M4 agent can target the exact job_id / pr_number without re-scanning agent_jobs.
        job_pr_context: c.brief.job_pr_context ?? null,
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
/** PURE predicate — is this spec row TERMINAL for Mario's purposes: archived/folded, explicitly
 *  `deferred`, or DERIVED-shipped (every phase shipped, which presents with a NULL raw `status`)?
 *
 *  The CEO directive (2026-07-16) is ABSOLUTE: Mario must never file a job on an archived/folded spec.
 *  The `evaluateStalledSpecs` survivor filter's (d) drop already drops these — EXCEPT it relaxes for the
 *  `orphaned_folded_pr` ninth source (folded spec + open PR), which the moment the box regained pipeline
 *  visibility mass-enqueued 65 Max-session jobs against just-folded pipeline specs (goal-serializer,
 *  parallel-build-*, mario-detects-*, pr-resolve-retry-cap-*). This predicate powers a HARD guard at the
 *  `enqueueMarioJob` chokepoint below that overrides that relax for EVERY candidate source (current or
 *  future) — so no folded-spec flood can recur regardless of which source produced the candidate.
 *  Orphaned-PR cleanup on a folded spec is a deterministic fold-time concern
 *  ([[pr-resolve-retry-cap-and-fold-closes-orphan-pr]]), never a per-PR Max session. Kept pure +
 *  exported so the guard is unit-testable without a Supabase seam (mirrors the survivor-filter (d)
 *  derivedShipped logic — one definition of "terminal for Mario"). */
export function isMarioTerminalSpec(specRow: Pick<SpecRow, "status" | "phases">): boolean {
  const derivedShipped =
    specRow.phases.length > 0 && specRow.phases.every((p) => p.status === "shipped");
  return specRow.status === "folded" || specRow.status === "deferred" || derivedShipped;
}

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

  // TERMINAL-SPEC HARD GUARD (CEO 2026-07-16 — "Mario must not work on archived/folded specs", absolute).
  // The enqueue chokepoint refuses ANY candidate whose spec is folded / deferred / derived-shipped, even
  // the orphaned_folded_pr ninth source whose survivor-filter (d) relax would otherwise let it through.
  // This is the load-bearing invariant: a folded spec never gets a Max-session mario job, period, no matter
  // the source. Fail-OPEN on a missing row (the phantom / pr-<n> job/PR class carries no specs row and is a
  // legitimate Mario target — the survivor filter's (d0) already vetted it).
  const specRow = await getSpecFromDb(candidate.workspace_id, candidate.spec_slug);
  if (specRow && isMarioTerminalSpec(specRow)) {
    return { enqueued: false, reason: "terminal_spec" };
  }

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
  /** Vocabulary key: redrive_dropped_job | unstick_stale_status | release_cleared_blocker | requeue_unclaimed_job | queue_box_restart | reclaim_and_redrive | cancel_pr_resolve_storm | close_orphaned_pr | ...open slot. */
  action: string;
  /** The specific row/slug/box/PR the action mutates — Phase 3 helpers each read exactly one field.
   *  `pr_number` (mario-detects-job-and-pr-wedges Phase 2) is set for the `cancel_pr_resolve_storm`
   *  verdict — the target row-set is every parked pr-resolve row for that PR. */
  target: { spec_slug?: string; job_id?: string; box_id?: string; pr_number?: number };
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

/** A repair of a spec's MISSING blocked_by entry — the fifth candidate source (Vale-review-failed with
 *  a `**Blocked-by:** [[foo]]` metadata line whose slug never made it onto the `specs.blocked_by` column).
 *  ADDITIVE-ONLY: the verb names slugs to UNION into the existing column; the applier NEVER removes an
 *  existing blocker (a removal would silently drop a real prerequisite). An empty `add_blocked_by` is
 *  rejected at the mutator boundary. `applyBoxMario` re-authors the spec through the author-spec gate with
 *  the merged list, which reopens it to Vale (clears `vale_pass`). */
export interface MarioBlockedByRepair {
  spec_slug: string;
  /** The slugs to UNION into `specs.blocked_by`. Must be non-empty; each must be a bare slug (no
   *  `../specs/` prefix, no `.md` suffix). */
  add_blocked_by: string[];
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
  blocked_by_repair: MarioBlockedByRepair | null;
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
  blocked_by_repair: null,
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
      // pr_number is a plain integer — accept it verbatim only when it is a finite positive integer,
      // so a stray string or negative can never reach the applier's `.eq('pr_number', …)` compare-and-set.
      const rawPrNumber = target.pr_number;
      const prNumberValid =
        typeof rawPrNumber === "number" && Number.isFinite(rawPrNumber) && rawPrNumber > 0 && Number.isInteger(rawPrNumber);
      live_fix = {
        action,
        target: {
          spec_slug: typeof target.spec_slug === "string" ? target.spec_slug : undefined,
          job_id: typeof target.job_id === "string" ? target.job_id : undefined,
          box_id: typeof target.box_id === "string" ? target.box_id : undefined,
          pr_number: prNumberValid ? rawPrNumber : undefined,
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

  let blocked_by_repair: MarioBlockedByRepair | null = null;
  if (r.blocked_by_repair && typeof r.blocked_by_repair === "object") {
    const b = r.blocked_by_repair as Record<string, unknown>;
    const spec_slug = typeof b.spec_slug === "string" ? b.spec_slug : "";
    const rawAdd = Array.isArray(b.add_blocked_by) ? b.add_blocked_by : [];
    const add_blocked_by = rawAdd
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      // Strip a caller-side `../specs/` prefix / `.md` suffix so a wikilink-shaped input matches the
      // bare-slug expectation on `specs.blocked_by`.
      .map((s) => s.replace(/^.*\//, "").replace(/\.md$/, ""))
      .filter((s) => s.length > 0);
    if (spec_slug && add_blocked_by.length > 0) {
      blocked_by_repair = { spec_slug, add_blocked_by: [...new Set(add_blocked_by)], reasoning: typeof b.reasoning === "string" ? b.reasoning : "" };
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

  return { trigger_accurate, live_fix, durable_fix_spec, verification_repair, blocked_by_repair, threshold_adjustment, escalate, reasoning };
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

/** `close_orphaned_pr` — close an open claude/build-* PR whose spec has folded/shipped (mario-detects-
 *  job-and-pr-wedges Phase 3). The full case #1893: a folded-spec PR sat open + conflicting for 7 h,
 *  storming pr-resolve until Mario Phase 2 catches the storm — but the root cause is the orphaned PR
 *  itself. This applier CONFIRMS the spec is still folded/shipped RIGHT BEFORE firing (guard-before-
 *  mutation — a between-detection-and-apply un-fold means we do NOT close the PR), reads the branch
 *  from `agent_jobs.spec_branch`, fetches the PR's current head sha via `getPrHead`, then calls
 *  [[github-pr-resolve]] `closeDuplicatePr` (with `expectedHeadSha` so the mutation is authorized
 *  against the exact head we saw + a mario-branded comment). Any drift (spec un-folded, no build row,
 *  PR already closed/merged, head SHA moved) fails closed with a reason on the mario_fired row —
 *  never destructive. Throws when the confirm-at-fire guard rejects the write. */
async function closeOrphanedPr(admin: Admin, workspaceId: string, specSlug: string): Promise<{ prNumber: number; closed: boolean; reason?: string }> {
  // Guard 1: re-read the spec status right now. Between detection (source a9) and this applier fire
  // the spec could have been re-opened (un-folded, un-shipped-with-error-correction); do NOT close a
  // PR whose spec is no longer terminal.
  const spec = await getSpecFromDb(workspaceId, specSlug);
  if (!spec) throw new Error(`close_orphaned_pr: spec ${specSlug} not found`);
  if (spec.status !== "folded" && spec.status !== "shipped") {
    throw new Error(`close_orphaned_pr: spec ${specSlug} status is ${spec.status ?? "null"} (not folded/shipped) — refusing to close PR`);
  }

  // Guard 2: read the ONE most-recent build row for this spec that carries a pr_number and is not
  // already `merged`. This is the same enumeration the detector used, applied fresh at fire time.
  const { data: builds, error: buildErr } = await admin
    .from("agent_jobs")
    .select("pr_number, spec_branch, status, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", specSlug)
    .eq("kind", "build")
    .not("pr_number", "is", null)
    .neq("status", "merged")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (buildErr) throw new Error(`close_orphaned_pr: build lookup failed: ${buildErr.message}`);
  const build = (builds ?? [])[0] as { pr_number: number | null; spec_branch: string | null; status: string } | undefined;
  if (!build || build.pr_number == null) throw new Error(`close_orphaned_pr: no open-PR build row for ${specSlug}`);
  if (build.status === "merged") throw new Error(`close_orphaned_pr: build row already merged (${specSlug})`);
  const prNumber = build.pr_number;
  const branch = build.spec_branch;
  if (!branch || !branch.startsWith("claude/")) {
    // Mario NEVER touches a human PR — the branch shape is the guard, matching detectAndEnqueueDirtyPrs.
    throw new Error(`close_orphaned_pr: branch ${branch ?? "null"} not a claude/* branch — refusing to close`);
  }

  // Guard 3: fetch the PR's current head SHA — `closeDuplicatePr` needs it as an authorization anchor
  // (fail-closed on any state=closed / merged / fork-head / head.sha drift between our read + PATCH).
  const { getPrHead, closeDuplicatePr } = await import("@/lib/github-pr-resolve");
  const head = await getPrHead(prNumber);
  if (!head.ok) throw new Error(`close_orphaned_pr: PR #${prNumber} head fetch failed: ${head.reason}`);
  if (head.headRef !== branch) throw new Error(`close_orphaned_pr: head.ref=${head.headRef} does not match agent_jobs.spec_branch=${branch}`);

  const comment = `Closing as an orphaned PR: this spec (\`${specSlug}\`) has already ${spec.status === "folded" ? "folded" : "shipped"} — the work is settled and this open PR is superseded. Auto-closed by mario (\`close_orphaned_pr\` — mario-detects-job-and-pr-wedges Phase 3).`;
  const res = await closeDuplicatePr(prNumber, branch, comment, { expectedHeadSha: head.headSha });
  if (!res.ok) throw new Error(`close_orphaned_pr: closeDuplicatePr refused: ${res.reason ?? "unknown"}`);
  return { prNumber, closed: true, reason: res.reason };
}

/** `cancel_pr_resolve_storm` — cancel every parked pr-resolve row for one PR (mario-detects-job-and-pr-
 *  wedges Phase 2). The dirty-PR resolver re-enqueues on each webhook, and a PR whose resolver keeps
 *  landing `needs_attention`/`failed` piles up rows the deduper alone can't clear (each parked row is
 *  its own storm). Flip every parked row (`needs_attention`/`failed`) for this pr_number to `completed`
 *  with a mario cancellation reason on `error` so the deduper's active-row guard lets a fresh resolve
 *  enqueue on the next webhook. Compare-and-set on `kind='pr-resolve'` + `pr_number` + status; workspace-
 *  scoped so a cross-workspace pr_number collision cannot cross-write. Returns the count for the
 *  audit-metadata `mario_fired` row; throws when zero rows matched (the storm cleared itself). */
async function cancelPrResolveStorm(admin: Admin, workspaceId: string, prNumber: number): Promise<number> {
  const nowIso = new Date().toISOString();
  const reason = `mario cancel_pr_resolve_storm: PR #${prNumber} — pr-resolve storm cancelled (dedupe: one live resolve per PR is enough; next webhook re-enqueues cleanly)`;
  const { data: cancelled, error } = await admin
    .from("agent_jobs")
    .update({ status: "completed", error: reason, updated_at: nowIso })
    .eq("workspace_id", workspaceId)
    .eq("kind", "pr-resolve")
    .eq("pr_number", prNumber)
    .in("status", ["needs_attention", "failed"])
    .select("id");
  if (error) throw new Error(`cancel_pr_resolve_storm: ${error.message}`);
  const count = Array.isArray(cancelled) ? cancelled.length : 0;
  if (count === 0) throw new Error(`cancel_pr_resolve_storm: no parked pr-resolve rows matched for PR #${prNumber}`);
  return count;
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

/**
 * Pure discriminator — is this spec a GOAL MEMBER that is already INTEGRATED on its goal branch and
 * merely awaiting the atomic goal→main promotion? A goal member NEVER merges to main until M5's atomic
 * `promoteCompleteGoalsToMain`; its correct terminal-before-promotion state is "on the goal branch"
 * (`specs.goal_branch_sha` stamped by [[stampSpecGoalBranchSha]]). Reclaim-and-redrive's "built-but-
 * unmerged" class measures against MAIN, so for such a member it fires a false-positive: rebuilding
 * on a fresh branch head resets `isSpecTestGreenForBranch` → flips `isSpecPromoteEligible` false →
 * blocks `promoteCompleteGoalsToMain` (the 2026-07-12 director-chats stall).
 *
 * True iff ALL THREE hold:
 *   1. `milestoneId !== null` — it's a goal member (specs with no milestone are unaffected — a standalone
 *      spec's integration target IS main, so the built-but-unmerged class applies as today).
 *   2. `goalBranchSha !== null` — its `claude/build-<slug>` branch has already merged onto `goal/<goalSlug>`
 *      (M4 `stampSpecGoalBranchSha`). "Unmerged" for a goal member means "not on its goal branch",
 *      NEVER "not on main".
 *   3. `goalMainMergeSha === null` — the goal itself has NOT yet atomically promoted to main. A goal
 *      already-promoted (has a main_merge_sha) means the spec IS on main via M5, so a genuinely orphaned
 *      "not on main" reading is impossible for it; a stall of a *different* class handles the rare
 *      after-promotion drift.
 *
 * A pure predicate — no I/O. The I/O wrapper `isSpecAwaitingGoalPromotion` below resolves the fields
 * from `specs` + `goal_milestones` + `goals`. Kept exported so the unit tests can pin it without any
 * Supabase stub (mirrors [[shouldSurfaceMissingBlocker]]'s split of I/O from decision).
 */
export function isGoalMemberAwaitingPromotion(input: {
  milestoneId: string | null;
  goalBranchSha: string | null;
  goalMainMergeSha: string | null;
}): boolean {
  if (input.milestoneId === null) return false;
  if (input.goalBranchSha === null) return false;
  if (input.goalMainMergeSha !== null) return false;
  return true;
}

/**
 * PURE predicate — should the eligible-never-enqueued candidate be DROPPED because the goal-member
 * build-dispatch serializer is legitimately holding it? An eligible-but-serially-held goal member
 * has `auto_build=true`, every declared blocker cleared, and NO build job — the exact shape the
 * sixth source (`from_event === "spec_authored"`) surfaces — but the goal serializer is
 * intentionally holding it (a conflicting goal-mate build is in flight OR this mate is not the
 * earliest ready head). There is no honest live fix: a reclaim would be refused by the same gate
 * and queueing anew would churn on the claim-time serializer. Dropping the candidate at the source
 * means no `mario_fired` row, no oscillation-guard pressure, and no wasted Max session.
 *
 * SCOPED to the sixth source's `from_event` so the other sources (failed-build, stuck-queued,
 * pr-resolve-storm, orphaned-folded-pr, …) are UNTOUCHED — those classes carry a real job to act
 * on and the serial-build gate does not apply.
 *
 * A one-off spec (resolveGoalSlugForSpec → null → dispatch ok:true) and an admissible goal member
 * (no conflicting mate → ok:true) return `false` from this predicate — they are NEVER dropped by
 * this filter. Only a member the serializer is actively refusing (ok:false) returns `true`.
 *
 * Kept pure so the drop decision is unit-testable without a stubbed Supabase client (mirrors
 * [[shouldSurfaceEligibleNeverEnqueued]] and [[isGoalMemberAwaitingPromotion]]).
 */
export function shouldDropSeriallyHeldGoalMember(input: {
  fromEvent: string;
  dispatch: GoalMemberBuildDispatchResult;
}): boolean {
  if (input.fromEvent !== "spec_authored") return false;
  return input.dispatch.ok === false;
}

/**
 * I/O wrapper for [[isGoalMemberAwaitingPromotion]] — resolves the fields the pure predicate needs
 * from `specs` + `goal_milestones` + `goals`. Reads only; never mutates. Fails CLOSED to `false` (a
 * lookup error means "we don't know if this is a goal member awaiting promotion", so we default to the
 * SAFER prior behavior of allowing the reclaim class — a genuinely orphaned build must still be
 * reclaimed). This mirrors the fail-closed contract in [[isSpecOnGoalBranch]] (an unknown state must
 * NOT be treated as "on the goal branch" — safer to hold than to skip a real signal).
 *
 * Used at BOTH `reclaim_and_redrive` gates (the vocabulary case in [[applyBoxMario]] AND the escalate →
 * [[surfaceMarioEscalationToAda]] path) so no reclaim build job is created for an integrated-awaiting
 * goal member, however the verdict routes the request.
 */
async function isSpecRowAwaitingGoalPromotion(admin: Admin, spec: SpecRow): Promise<boolean> {
  try {
    if (!spec.milestone_id) return false;
    // Not yet on the goal branch → this IS a genuine "not integrated" state; the reclaim class still owns it.
    if (!spec.goal_branch_sha) return false;
    // Resolve the milestone → goal_id → goal.main_merge_sha in one small pair of reads.
    const { data: milestone, error: mErr } = await admin
      .from("goal_milestones")
      .select("goal_id")
      .eq("id", spec.milestone_id)
      .maybeSingle();
    if (mErr || !milestone) return false;
    const { data: goal, error: gErr } = await admin
      .from("goals")
      .select("main_merge_sha")
      .eq("id", (milestone as { goal_id: string }).goal_id)
      .maybeSingle();
    if (gErr || !goal) return false;
    return isGoalMemberAwaitingPromotion({
      milestoneId: spec.milestone_id,
      goalBranchSha: spec.goal_branch_sha,
      goalMainMergeSha: (goal as { main_merge_sha: string | null }).main_merge_sha,
    });
  } catch {
    return false; // fail closed — an unknown state defaults to prior reclaim behavior.
  }
}

async function isSpecAwaitingGoalPromotion(
  admin: Admin,
  workspaceId: string,
  specSlug: string,
): Promise<boolean> {
  try {
    const spec = await getSpecFromDb(workspaceId, specSlug);
    if (!spec) return false;
    return await isSpecRowAwaitingGoalPromotion(admin, spec);
  } catch {
    return false;
  }
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
 *  `assertEveryPhaseHasVerification` + `assertEveryNodeHasIntent` re-gate the payload at the DB write.
 *
 *  mario-fix-authoring-emits-machine-checks-not-needs-human Phase 1 — attach a typed machine check per
 *  phase. Without `checks[]`, `authorSpecRowStructured` falls back to
 *  `parseVerificationBlobToChecks(verification)`, which stamps every prose bullet with
 *  `exec_kind='needs_human'` → `assertEveryPhaseHasMachineCheck` throws → the fix-spec never lands →
 *  the origin stays red → the stall detector re-fires → oscillation. A default
 *  `{kind:'auto', exec_kind:'tsc', params:null}` check is the safe default already used by
 *  `buildStructuredSpecInputFromMarkdown` (author-spec.ts) and by [[repair-agent]]'s
 *  `derivedDefaultRepairChecks` — the prose verification stays on the `verification` column verbatim
 *  for humans; the tsc check gives the deterministic runner something to actually execute. */
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
        checks: defaultMarioFixPhaseChecks(),
      })),
    },
    "planned",
    { intendedStatusSetBy: "mario", parentKind: "mandate", parentRef: `${MARIO_DIRECTOR_FUNCTION}#${MARIO_FIX_MANDATE_SLUG}` },
  );
}

/** mario-fix-authoring-emits-machine-checks-not-needs-human Phase 1 — the default machine check every
 *  Mario-authored fix phase carries so `assertEveryPhaseHasMachineCheck` at the author chokepoint
 *  cannot reject the write (which was stranding fix-specs built-but-unmerged and re-firing the stall
 *  detector). A bare `tsc` gate — same shape `buildStructuredSpecInputFromMarkdown` uses in the
 *  markdown author path — is safe across every Mario fix class: a pipeline-reliability fix landing on
 *  `main` MUST typecheck. The prose the LLM proposed rides verbatim on the phase's `verification`
 *  column (human-facing); the tsc check is what the deterministic runner actually executes. */
function defaultMarioFixPhaseChecks(): SpecPhaseCheckInput[] {
  return [
    {
      position: 1,
      description: "Repo typechecks clean (`npx tsc --noEmit`) after this phase lands.",
      kind: "auto",
      exec_kind: "tsc",
      params: null,
    },
  ];
}

/** Pure security predicate for `blocked_by_repair` — recompute the fifth-source class as-of NOW and reject
 *  any verdict that either (a) names a spec_slug different from the Mario job row's spec_slug (the LLM
 *  can't retarget the repair), (b) points at a spec whose current state no longer fits the missing-blocker
 *  class per [[shouldSurfaceMissingBlocker]] (folded/deferred, still within grace, a real phase lost its
 *  verification, the body's `**Blocked-by:**` line was cleared, or every named prerequisite is already on
 *  the row), or (c) requests any add_blocked_by entry that isn't in the derived missing set (current body
 *  named prerequisites MINUS current `specs.blocked_by`). Split out of `repairSpecBlockedBy` so the exact
 *  security contract is unit-testable without a Supabase stub. scope-mario-blocked-by-repair-target Phase 1. */
export function checkRepairBlockedByScope(input: {
  jobSpecSlug: string;
  repair: MarioBlockedByRepair;
  spec: {
    status: string | null;
    updated_at: string | null;
    body: string;
    blocked_by: string[];
    phases: Array<{ kind: string; verification: string | null }>;
  } | null;
  graceMs: number;
  now: number;
}): { ok: true; missingSet: string[] } | { ok: false; reason: string } {
  if (input.repair.spec_slug !== input.jobSpecSlug) {
    return { ok: false, reason: `spec_slug_mismatch: job=${input.jobSpecSlug} verdict=${input.repair.spec_slug}` };
  }
  if (!input.spec) return { ok: false, reason: `spec_not_found: ${input.jobSpecSlug}` };
  const realPhases = input.spec.phases.filter((p) => p.kind !== "fix").map((p) => ({ verification: p.verification }));
  const ageMs = input.spec.updated_at ? input.now - Date.parse(input.spec.updated_at) : 0;
  const inClass = shouldSurfaceMissingBlocker({
    status: input.spec.status,
    ageMs,
    graceMs: input.graceMs,
    realPhases,
    body: input.spec.body,
    blocked_by: input.spec.blocked_by,
  });
  if (!inClass) return { ok: false, reason: "not_missing_blocker_class" };
  const namedInBody = extractBlockedBySlugsFromBody(input.spec.body);
  const currentBlockedBy = new Set(input.spec.blocked_by);
  const missing = namedInBody.filter((s) => !currentBlockedBy.has(s));
  const missingSet = new Set(missing);
  const outOfSet = input.repair.add_blocked_by.filter((s) => !missingSet.has(s));
  if (outOfSet.length > 0) return { ok: false, reason: `add_not_in_missing_set: ${outOfSet.join(",")}` };
  return { ok: true, missingSet: missing };
}

/** Pure decision predicate for `blocked_by_repair` — compute the merged `blocked_by` (UNION of existing +
 *  add) or reject the verdict. ADDITIVE-ONLY: an empty `add_blocked_by` is rejected (Phase-2 verification
 *  bullet 2); a would-be REMOVAL is rejected — the applier never accepts a payload that omits an existing
 *  blocker (verification bullet 2's "drop existing blocker → rejected"). Returns `{ ok: false }` when the
 *  merged set would drop an entry or the add-list is empty; else `{ ok: true, merged }`. Split out of
 *  `repairSpecBlockedBy` so the exact contract is unit-testable without a Supabase stub. */
export function mergeBlockedByForRepair(input: {
  existing: string[];
  add: string[];
}): { ok: true; merged: string[] } | { ok: false; reason: "empty_add" | "would_drop_existing" } {
  const trimmedAdd = input.add.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0);
  if (trimmedAdd.length === 0) return { ok: false, reason: "empty_add" };
  const existingSet = new Set(input.existing);
  const merged = [...input.existing];
  for (const s of trimmedAdd) {
    if (!existingSet.has(s)) {
      merged.push(s);
      existingSet.add(s);
    }
  }
  // Belt-and-suspenders: the union CAN'T drop an existing entry by construction, but re-assert it so a
  // future refactor that swaps to a replace-style payload is caught at the predicate boundary, not silently
  // in prod.
  for (const s of input.existing) {
    if (!merged.includes(s)) return { ok: false, reason: "would_drop_existing" };
  }
  return { ok: true, merged };
}

/** Parse a pr-resolve pseudo-slug `pr-<number>` back to its integer PR number. Returns `null` on any
 *  slug that isn't a bare `pr-<positive integer>` shape (a real spec slug, a `pr-abc` typo, `pr--5`, …).
 *  Used by `checkCancelPrResolveStormScope` to derive the DETERMINISTIC surfaced pr_number from the
 *  Mario job row's `spec_slug` (mario-detects-job-and-pr-wedges Phase 4 — bind live-fix targets to the
 *  job row context so an LLM verdict cannot retarget a mutation to a sibling PR). */
export function parsePrResolvePseudoSlug(slug: string): number | null {
  const m = slug.match(/^pr-(\d+)$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Pure security predicate for `cancel_pr_resolve_storm` (mario-detects-job-and-pr-wedges Phase 4 fix).
 *  Recompute the DETERMINISTIC surfaced pr_number from the Mario job row's `spec_slug` (the eighth source
 *  stamps the pseudo-slug `pr-<number>` on the surfacing candidate → applyBoxMario reads `row.spec_slug`)
 *  and reject any verdict that either (a) is missing target.pr_number entirely, (b) targets a pr_number
 *  the Mario job row was NOT surfaced for, or (c) was surfaced under a non-pr pseudo-slug (defensive:
 *  the deterministic source ONLY emits `pr-<n>` for this class; any other shape is a mis-routed verdict).
 *  Split out of `applyBoxMario`'s switch so the exact security contract is unit-testable without a
 *  Supabase stub. */
export function checkCancelPrResolveStormScope(input: {
  jobSpecSlug: string;
  target: { pr_number?: number };
}): { ok: true; prNumber: number } | { ok: false; reason: string } {
  const surfacedPrNumber = parsePrResolvePseudoSlug(input.jobSpecSlug);
  if (surfacedPrNumber === null) {
    return { ok: false, reason: `job_spec_slug_not_pseudo_pr: ${input.jobSpecSlug}` };
  }
  if (typeof input.target.pr_number !== "number") {
    return { ok: false, reason: "target_pr_number_missing" };
  }
  if (input.target.pr_number !== surfacedPrNumber) {
    return {
      ok: false,
      reason: `pr_number_mismatch: job=${surfacedPrNumber} verdict=${input.target.pr_number}`,
    };
  }
  return { ok: true, prNumber: surfacedPrNumber };
}

/** Pure security predicate for `close_orphaned_pr` (mario-detects-job-and-pr-wedges Phase 4 fix). The
 *  ninth source stamps the REAL spec_slug on the surfacing candidate → applyBoxMario reads it off
 *  `row.spec_slug`. Reject any verdict whose target.spec_slug differs from the Mario job row's spec_slug
 *  (an injected verdict cannot retarget the close to a SIBLING folded/shipped spec in the same
 *  workspace). Reject a target.pr_number that is provided but positive (should be re-derived from
 *  agent_jobs.spec_branch/pr_number inside `closeOrphanedPr`; a caller supplying a mismatched pr_number
 *  is the same class of authority drift). A missing target.spec_slug (verdict target = {}) is accepted
 *  as an implicit "use the job row's slug" — matches the pre-fix behavior for the well-formed case. */
export function checkCloseOrphanedPrScope(input: {
  jobSpecSlug: string;
  target: { spec_slug?: string; pr_number?: number };
}): { ok: true; specSlug: string } | { ok: false; reason: string } {
  if (typeof input.target.spec_slug === "string" && input.target.spec_slug !== input.jobSpecSlug) {
    return {
      ok: false,
      reason: `spec_slug_mismatch: job=${input.jobSpecSlug} verdict=${input.target.spec_slug}`,
    };
  }
  return { ok: true, specSlug: input.jobSpecSlug };
}

/** Repair a spec's MISSING blocked_by entry (the fifth candidate source class). Re-authors the spec with
 *  the merged `blocked_by` (UNION of existing + verdict.add_blocked_by) via the SAME author-spec gate that
 *  the verification repair uses — a content change re-opens the spec to Vale (`markSpecCardBackToReview`
 *  clears `vale_pass` + `vale_review_passed_at`; author-spec.ts). ADDITIVE-ONLY: an empty add-list, or a
 *  payload that would DROP an existing blocker, is rejected at `mergeBlockedByForRepair` and the applier
 *  throws — the caller records the throw on the mario_fired row. `jobSpecSlug` is the Mario job row's
 *  spec_slug (the stall detector's surface target); [[checkRepairBlockedByScope]] rejects any verdict
 *  whose `spec_slug` differs OR whose `add_blocked_by` names a slug outside the derived missing set
 *  (current body `**Blocked-by:**` prerequisites MINUS current `specs.blocked_by`) — the deterministic
 *  service-role worker only applies the exact missing-blocker repair the surfacer surfaced regardless of
 *  what the LLM verdict or the spec body says (scope-mario-blocked-by-repair-target Phase 1). */
async function repairSpecBlockedBy(
  admin: Admin,
  workspaceId: string,
  jobSpecSlug: string,
  repair: MarioBlockedByRepair,
): Promise<boolean> {
  const { getSpec } = await import("@/lib/specs-table");
  const { getSpec: getSpecFromRoadmap } = await import("@/lib/brain-roadmap");
  const { authorSpecRowStructured } = await import("@/lib/author-spec");
  // Read against the JOB'S spec_slug — never the verdict's — so a slug-mismatched verdict can't hit a
  // sibling spec even before the scope predicate rejects it.
  const cur = await getSpec(workspaceId, jobSpecSlug);
  // public.specs has never carried a `body` column — the raw spec markdown is reconstructed from
  // spec_phases by brain-roadmap.getSpec (`serializeSpecRowToMarkdown`), which is the SAME string
  // parseSpec used to populate specs.blocked_by. The fifth-source predicate + derived-missing set both
  // consume the current `**Blocked-by:**` line as-of NOW; sourcing from spec_phases keeps the read
  // consistent with `readReviewFailedBlockerStalls` and stops the `column specs.body does not exist`
  // crash that took out the mario-stall-cron evaluate-and-enqueue step.
  const roadmapSpec = await getSpecFromRoadmap(jobSpecSlug, workspaceId);
  const body = roadmapSpec?.raw ?? "";

  // Security gate — pure predicate: reject slug-mismatch, out-of-class spec, or add entries outside the
  // derived missing set. Runs BEFORE any getSpec/author-spec write side-effect below.
  const scope = checkRepairBlockedByScope({
    jobSpecSlug,
    repair,
    spec: cur
      ? {
          status: cur.status,
          updated_at: cur.updated_at,
          body,
          blocked_by: cur.blocked_by ?? [],
          phases: (cur.phases ?? []).map((p) => ({ kind: p.kind, verification: p.verification })),
        }
      : null,
    graceMs: MARIO_REVIEW_VERIFICATION_GRACE_MS,
    now: Date.now(),
  });
  if (!scope.ok) throw new Error(`repair_blocked_by: ${scope.reason}`);
  if (!cur) throw new Error(`repair_blocked_by: spec ${jobSpecSlug} not found`);
  const decision = mergeBlockedByForRepair({ existing: cur.blocked_by ?? [], add: repair.add_blocked_by });
  if (!decision.ok) throw new Error(`repair_blocked_by: ${decision.reason}`);

  // No content delta → no re-open → skip. A caller passing an add-list that's already a subset of the
  // existing blocked_by (a no-op) shouldn't waste an author-spec write or a mario_fixed row.
  const same =
    decision.merged.length === (cur.blocked_by ?? []).length &&
    decision.merged.every((s) => (cur.blocked_by ?? []).includes(s));
  if (same) return false;

  // Real (kind='phase') phases only — mirrors repairSpecVerification: the auto-generated fix phases are
  // never re-authored through this path (they'd be rebuilt on the next spec-test fail if still needed).
  const realPhases = (cur.phases ?? []).filter((p) => p.kind !== "fix");
  if (realPhases.length === 0) throw new Error("repair_blocked_by: no non-fix phases to re-author");
  const phases = realPhases.map((p) => ({
    title: p.title,
    // Intent gate needs non-empty why/what per phase — same fallback shape as repairSpecVerification so a
    // spec authored before the intent gate landed can still round-trip.
    why: (p.why && p.why.trim()) || cur.why || `Phase ${p.position} of ${cur.title}.`,
    what: (p.what && p.what.trim()) || cur.what || cur.title,
    body: (p.body && p.body.trim()) || p.title,
    // Preserve current verification — the Verification gate throws on empty; this repair is scoped to
    // blocked_by, never touches per-phase verification (that's the fourth source's verb).
    verification: p.verification ?? "",
    // mario-fix-authoring-emits-machine-checks-not-needs-human Phase 1 — same defect class as
    // authorMarioFixSpec / repairSpecVerification: a re-author that falls back to
    // parseVerificationBlobToChecks yields all-needs_human → assertEveryPhaseHasMachineCheck throws
    // → the blocked_by repair never lands. Attach the same default tsc check so the fifth-source
    // repair can't strand via the same gate.
    checks: defaultMarioFixPhaseChecks(),
  }));

  const hasTypedMandate = cur.parent_kind === "mandate" && typeof cur.parent_ref === "string" && cur.parent_ref.includes("#");
  const parentRef = hasTypedMandate ? (cur.parent_ref as string) : `${cur.owner}#infra-devops-reliability`;
  const parentProse = cur.parent && cur.parent.includes("mandate") ? cur.parent : `[[../functions/${cur.owner}]] — "Infra & DevOps / reliability" mandate: blocked_by repair.`;

  // Author against the JOB'S spec_slug — the scope predicate already asserted `repair.spec_slug === jobSpecSlug`
  // so this is defensive belt-and-suspenders: a future refactor that shortcuts the guard still can't reach a
  // sibling spec through the author-spec write.
  return await authorSpecRowStructured(
    workspaceId,
    jobSpecSlug,
    {
      title: cur.title,
      summary: cur.summary,
      owner: cur.owner,
      parent: parentProse,
      why: cur.why ?? cur.title,
      what: cur.what ?? cur.title,
      blocked_by: decision.merged,
      autoBuild: true,
      phases,
    },
    "planned",
    { intendedStatusSetBy: "mario", parentKind: "mandate", parentRef },
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
    // mario-fix-authoring-emits-machine-checks-not-needs-human Phase 1 — attach a typed machine check per
    // phase so `assertEveryPhaseHasMachineCheck` at the author chokepoint can't reject the re-author with
    // `MissingMachineCheckError`. Without this, the re-author falls back to
    // `parseVerificationBlobToChecks(verification)` — every prose bullet stamped `needs_human` → the
    // machine-check gate throws → the verification repair never lands → the origin stays red → oscillation.
    // Same default as `authorMarioFixSpec` (see [[defaultMarioFixPhaseChecks]]).
    checks: defaultMarioFixPhaseChecks(),
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
          case "reclaim_and_redrive": {
            const targetSlug = lf.target.spec_slug ?? row.spec_slug;
            // Discriminator: an integrated goal member awaiting the atomic promotion is NOT built-but-
            // unmerged (its integration target is its goal branch, not main). Reclaiming it rebuilds a
            // finished member on a new branch head → resets isSpecTestGreenForBranch → blocks the goal's
            // atomic promotion. Skip the fix with a reason instead of firing the rebuild.
            if (await isSpecAwaitingGoalPromotion(admin, row.workspace_id, targetSlug)) {
              fixReason = "goal_member_awaiting_promotion";
              break;
            }
            await reclaimAndRedrive(admin, row.workspace_id, targetSlug);
            fixExecuted = true;
            break;
          }
          case "cancel_pr_resolve_storm": {
            // mario-detects-job-and-pr-wedges Phase 4 fix (security binding). Bind the target pr_number
            // to the DETERMINISTIC surfaced pr_number derived from the Mario job row's spec_slug (the
            // eighth source stamps the pseudo-slug `pr-<number>` — parseable) BEFORE any GitHub/DB
            // mutation. An injected verdict targeting a sibling PR in the same workspace is rejected at
            // the predicate boundary — never reaches `cancelPrResolveStorm`. See
            // [[checkCancelPrResolveStormScope]] for the exact contract.
            const scope = checkCancelPrResolveStormScope({ jobSpecSlug: row.spec_slug, target: lf.target });
            if (!scope.ok) throw new Error(`cancel_pr_resolve_storm: ${scope.reason}`);
            await cancelPrResolveStorm(admin, row.workspace_id, scope.prNumber);
            fixExecuted = true;
            break;
          }
          case "close_orphaned_pr": {
            // mario-detects-job-and-pr-wedges Phase 4 fix (security binding). Bind the target spec_slug
            // to the DETERMINISTIC Mario job row's spec_slug (the ninth source stamps the REAL slug) so
            // an injected verdict targeting a sibling folded/shipped spec in the same workspace is
            // rejected at the predicate boundary — never reaches `closeOrphanedPr`'s GitHub PATCH. The
            // applier itself STILL confirms the spec is still folded/shipped RIGHT BEFORE firing
            // (guard-before-mutation). See [[checkCloseOrphanedPrScope]] for the exact contract.
            const scope = checkCloseOrphanedPrScope({ jobSpecSlug: row.spec_slug, target: lf.target });
            if (!scope.ok) throw new Error(`close_orphaned_pr: ${scope.reason}`);
            await closeOrphanedPr(admin, row.workspace_id, scope.specSlug);
            fixExecuted = true;
            break;
          }
          default:
            fixReason = `unknown action: ${lf.action}`;
        }
      } catch (e) {
        fixReason = errText(e);
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
        durableSpecAuthorError = errText(e);
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
        verificationRepairError = errText(e);
        console.warn(`[mario] verification repair FAILED (${verdict.verification_repair.spec_slug}): ${verificationRepairError}`);
      }
    }

    // Blocked-by repair — additive-only union that re-opens the spec to Vale (fifth-source class). Gated
    // on live + the SAME 24h loop-guard: at ≥ MARIO_LOOP_GUARD_MAX prior mario_fixed rows for THIS slug,
    // skip the repair + write a mario_loop_guard escalation instead ("same-class re-bounce" per the spec).
    let blockedByRepaired = false;
    let blockedByRepairError: string | null = null;
    let blockedByLoopGuardTriggered = false;
    if (verdict.blocked_by_repair && mode === "live") {
      if (priorFixes >= loopGuardMax) {
        blockedByLoopGuardTriggered = true;
        try {
          const { recordDirectorActivity } = await import("@/lib/director-activity");
          await recordDirectorActivity(admin, {
            workspaceId: row.workspace_id,
            directorFunction: MARIO_DIRECTOR_FUNCTION,
            actionKind: "mario_loop_guard",
            specSlug: row.spec_slug,
            reason: `oscillation risk: ${priorFixes} prior mario_fixed row(s) in 24h ≥ MARIO_LOOP_GUARD_MAX=${loopGuardMax}. blocked_by_repair skipped; escalating.`,
            metadata: {
              actor: MARIO_ACTOR,
              job_id: jobId,
              prior_fixes: priorFixes,
              loop_guard_max: loopGuardMax,
              proposed_action: "blocked_by_repair",
              proposed_target: verdict.blocked_by_repair.spec_slug,
              proposed_add_blocked_by: verdict.blocked_by_repair.add_blocked_by,
            },
          });
        } catch (e) {
          console.warn("[mario] blocked_by_repair loop-guard record failed:", e instanceof Error ? e.message : e);
        }
      } else {
        try {
          // Pass the Mario job row's spec_slug (the stall detector's surface target) — the repair path
          // scopes the write to it and rejects any verdict whose `spec_slug` differs
          // (scope-mario-blocked-by-repair-target Phase 1).
          blockedByRepaired = await repairSpecBlockedBy(admin, row.workspace_id, row.spec_slug, verdict.blocked_by_repair);
        } catch (e) {
          blockedByRepairError = errText(e);
          console.warn(`[mario] blocked_by_repair FAILED (${verdict.blocked_by_repair.spec_slug}): ${blockedByRepairError}`);
        }
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
    let escalateSkippedReason: string | null = null;
    if (verdict.escalate && !fixExecuted && !verificationRepaired && !blockedByRepaired && mode === "live") {
      // Same discriminator as the reclaim_and_redrive vocabulary case above: never surface an integrated
      // goal member as a stuck built-but-unmerged spec to Ada. surfaceMarioEscalationToAda creates a fresh
      // `reclaim_stuck_build` job (in-leash for Ada's auto-approval), which rebuilds the member on a new
      // branch head and resets its spec-test green signal — blocking the goal's atomic promotion (the exact
      // 2026-07-12 director-chats stall). The promotion's eligibility gate + the escort own driving it to
      // main; Mario leaves the goal member alone.
      if (await isSpecAwaitingGoalPromotion(admin, row.workspace_id, row.spec_slug)) {
        escalateSkippedReason = "goal_member_awaiting_promotion";
      } else {
        try {
          escalatedToAda = await surfaceMarioEscalationToAda(admin, row.workspace_id, row.spec_slug, verdict.reasoning ?? "", jobId);
        } catch (e) {
          console.warn("[mario] escalate-to-Ada surface failed:", e instanceof Error ? e.message : e);
        }
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
        escalate_skipped_reason: escalateSkippedReason,
        job_id: jobId,
        mode,
        fix_executed: fixExecuted,
        fix_reason: fixReason,
        durable_spec_authored: durableSpecAuthored,
        durable_spec_author_error: durableSpecAuthorError,
        verification_repaired: verificationRepaired,
        verification_repair_error: verificationRepairError,
        blocked_by_repaired: blockedByRepaired,
        blocked_by_repair_error: blockedByRepairError,
        blocked_by_loop_guard_triggered: blockedByLoopGuardTriggered,
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

    // On a successful blocked_by_repair, ALSO record `mario_fixed` — same rationale: the loop-guard's 24h
    // count feeds the "same-class re-bounce → escalate" gate. Without this row, a repair that landed but
    // didn't stick (Vale bounces the re-authored spec for a different missing blocker) would re-fire the
    // same repair every sweep with no ceiling.
    if (blockedByRepaired && verdict.blocked_by_repair) {
      try {
        await recordDirectorActivity(admin, {
          workspaceId: row.workspace_id,
          directorFunction: MARIO_DIRECTOR_FUNCTION,
          actionKind: "mario_fixed",
          specSlug: row.spec_slug,
          reason: (verdict.blocked_by_repair.reasoning ?? "").slice(0, 4000),
          metadata: {
            actor: MARIO_ACTOR,
            job_id: jobId,
            action: "blocked_by_repair",
            target: { spec_slug: verdict.blocked_by_repair.spec_slug },
            add_blocked_by: verdict.blocked_by_repair.add_blocked_by,
          },
        });
      } catch (e) {
        console.warn("[mario] mario_fixed (blocked_by_repair) record failed:", e instanceof Error ? e.message : e);
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
    return { ok: false, reason: errText(e) };
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
    return { reverted: false, reason: errText(e) };
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
    return { stamped: false, reason: errText(e) };
  }
}
