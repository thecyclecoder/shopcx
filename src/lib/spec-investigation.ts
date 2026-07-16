/**
 * spec-investigation — the unified, READ-ONLY investigation SDK for the build pipeline.
 *
 * WHY THIS EXISTS. Answering "why did spec X fail spec-review?" / "what is spec X waiting on?" /
 * "why isn't spec X building?" used to mean a 10-minute dig across nine modules (specs-table raw rows,
 * brain-roadmap derived board, spec-test-runs, security-agent, agent-jobs, spec-timecards, director_activity,
 * goals-table, pipeline-doctor). This SDK is the single front door: it COMPOSES those existing readers
 * (it never re-derives status — the board rollup in brain-roadmap / pipeline-doctor stays authoritative) and
 * fills the five gaps that had no public reader:
 *   1. Vale's `needs_fix` reasoning  (was private in brain-roadmap behind the needs-fix RPC)
 *   2. a `director_activity` timeline  (director-activity.ts exports zero readers)
 *   3. a goal accumulation / atomic-promotion projection  (logic was buried in the promote WRITER)
 *   4. the timecard ledger ↔ pipeline-doctor bridge  (two disjoint views of the same spec)
 *   5. a first-class needs_input / needs_approval investigator  (who is it waiting on, for how long)
 *
 * It is READ-ONLY by construction — no writer is imported. The lifecycle it maps is documented in
 * docs/brain/lifecycles/spec-build-pipeline.md; every state/failure branch there has an entry point here.
 * Mario (src/lib/mario.ts) is the primary consumer — his box session investigates through this SDK instead
 * of ad-hoc queries, so his reasoning cites the same facts a human would see on the roadmap.
 */
import { createAdminClient } from "./supabase/admin";
import { diagnoseSpec, getLaneOccupancy, type SpecDiagnosis, type Severity } from "./pipeline-doctor";
import { getTimecard, type TimecardView, type TimecardOpenWait } from "./spec-timecards";
import { getSpec as getSpecRow, goalBranchState, type SpecPhaseRow, type GoalBranchState } from "./specs-table";
import {
  getLiveJobForSlug,
  resolveGoalSlugForSpec,
  isSpecPromoteEligible,
  assertReadyGoalNeverFrozenAndAutoBreak,
  type AgentJob,
  type SpecPromoteEligibility,
} from "./agent-jobs";
import { getGoal as getGoalRow, type GoalMilestoneRow } from "./goals-table";

type Admin = ReturnType<typeof createAdminClient>;

const now = () => Date.now();
const msSince = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, now() - t);
};

// ── Output shapes ────────────────────────────────────────────────────────────

/** Vale spec-review state + the failure reasoning (gap #1). */
export interface ReviewState {
  /** The tri-state raw flag: null = never reviewed, true = passed, false = needs_fix. */
  valePass: boolean | null;
  /** The durable "passed Vale" stamp the build claim-gate reads. `false` here with valePass=true is the
   *  legacy-disposition bug (passed but the durable flag never stamped → build silently held). */
  reviewPassed: boolean;
  /** Vale's latest needs_fix diagnosis (only present when valePass === false). */
  needsFixReason: string | null;
  /** The specific malformations Vale named (metadata.defects on the needs_fix row). */
  defects: string[];
  /** Human-readable summary of what the review state means for the build. */
  verdict: "passed" | "needs_fix" | "never_reviewed" | "passed_but_unstamped";
}

/** What a spec is blocked/parked on right now (gap #5 + blockers + serialization). */
export interface WaitingState {
  waiting: boolean;
  kind:
    | "none"
    | "needs_input"
    | "needs_approval"
    | "blocked_by"
    | "goal_member_serialized"
    | "usage_cap"
    | "held"
    | "dismissed"
    | "needs_attention";
  /** One-sentence explanation. */
  detail: string;
  /** The questions / pending-action prompts a needs_input/needs_approval job is parked on. */
  prompts: string[];
  /** Who the wait is on (owner / CEO / a blocker slug / a Max cap), when knowable. */
  waitingOn: string | null;
  /** How long it's been waiting (ms), from the job transition or the open timecard wait span. */
  sinceMs: number | null;
}

/** A fix phase auto-appended by the pre-merge spec-test / security fail path (gap around fix phases). */
export interface FixPhaseInfo {
  index: number; // 1-based position
  title: string;
  status: string;
  built: boolean;
  build_sha: string | null;
  merge_sha: string | null;
  /** The stable check keys this fix was spawned to resolve. */
  originCheckKeys: string[];
}

/** One entry in the "what happened to this spec" timeline (gap #2 + #4 merged). */
export interface TimelineEvent {
  at: string;
  /** "director_activity" (a review/dispose/heal/mario action) or "timecard" (a lifecycle-step event). */
  source: "director_activity" | "timecard";
  kind: string; // action_kind or event_kind
  actor: string | null;
  detail: string | null;
  metadata: Record<string, unknown>;
}

/** Goal-level accumulation + atomic-promotion projection (gap #3). */
export interface GoalContext {
  goalSlug: string;
  status: string;
  /** Every member has landed on the goal branch (goal_branch_sha stamped). */
  allSpecsAccumulated: boolean;
  memberCount: number;
  accumulatedCount: number;
  /** Members still not on the goal branch (the ones the goal is waiting on). */
  pendingMembers: string[];
  /** The atomic goal→main merge SHA, or null while the goal hasn't promoted. */
  mainMergeSha: string | null;
  /** A conflict/hold reason if the goal→main merge is stuck. */
  promotionHeld: string | null;
}

/** The full lifecycle snapshot for one spec — the "everything" call. */
export interface SpecInvestigation {
  slug: string;
  /** The pipeline-doctor diagnosis (derived+raw status, phases, jobs, spec-test, security, stuck verdict).
   *  NULL for a folded/archived spec (not on the board) — the other fields are still populated from the raw
   *  readers so a retrospective "why did this folded spec fail review" still answers. */
  diagnosis: SpecDiagnosis | null;
  /** True when the spec is folded/archived (off the board) — the diagnosis is null but review/timeline hold. */
  folded: boolean;
  review: ReviewState;
  waiting: WaitingState;
  fixPhases: FixPhaseInfo[];
  timecard: TimecardView;
  timeline: TimelineEvent[];
  goal: GoalContext | null;
  /** The single crisp "is it stuck and why" verdict, lifted from the diagnosis for convenience. */
  headline: { stuck: boolean; severity: Severity; reason: string; suggestedAction: string | null };
}

/** Why a spec is not currently building (ranked, single primary reason). */
export interface NotBuildingReason {
  building: boolean;
  reason:
    | "building"
    | "shipped"
    | "folded"
    | "blocked_by"
    | "not_review_passed"
    | "goal_member_serialized"
    | "ready_goal_deadlock"
    | "parked_needs_input"
    | "parked_needs_approval"
    | "usage_cap"
    | "no_build_job"
    | "lane_saturated"
    | "deferred"
    | "unknown";
  detail: string;
  /** The next move that would unstick it (from the doctor's suggestedAction, when available). */
  suggestedAction: string | null;
}

// ── Internal readers for the gaps ────────────────────────────────────────────

/** Latest `spec_review_needs_fix` director_activity row → Vale's reasoning + named defects (gap #1). */
async function readNeedsFix(
  admin: Admin,
  workspaceId: string,
  slug: string,
): Promise<{ reason: string | null; defects: string[] }> {
  const { data } = await admin
    .from("director_activity")
    .select("reason, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("action_kind", "spec_review_needs_fix")
    .order("created_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as { reason: string | null; metadata: Record<string, unknown> } | undefined;
  if (!row) return { reason: null, defects: [] };
  const rawDefects = (row.metadata ?? {})["defects"];
  const defects = Array.isArray(rawDefects) ? rawDefects.map((d) => String(d)) : [];
  return { reason: row.reason ?? null, defects };
}

/** director_activity rows for one spec, newest first (gap #2 — director-activity.ts exports no reader). */
async function readDirectorActivity(
  admin: Admin,
  workspaceId: string,
  slug: string,
  limit: number,
): Promise<TimelineEvent[]> {
  const { data } = await admin
    .from("director_activity")
    .select("action_kind, director_function, reason, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as {
    action_kind: string;
    director_function: string | null;
    reason: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }[]).map((r) => {
    const md = r.metadata ?? {};
    const actor = typeof md["actor"] === "string" ? (md["actor"] as string) : r.director_function;
    return {
      at: r.created_at,
      source: "director_activity" as const,
      kind: r.action_kind,
      actor,
      detail: r.reason,
      metadata: md,
    };
  });
}

/** Goal accumulation + atomic-promotion projection (gap #3). */
export async function getGoalContext(workspaceId: string, goalSlug: string): Promise<GoalContext | null> {
  const [row, branch] = await Promise.all([
    getGoalRow(workspaceId, goalSlug),
    goalBranchState(workspaceId, goalSlug) as Promise<GoalBranchState>,
  ]);
  if (!row) return null;
  const members = branch.specs ?? [];
  const accumulated = members.filter((m) => m.onGoalBranch);
  const pending = members.filter((m) => !m.onGoalBranch).map((m) => m.slug);
  return {
    goalSlug,
    status: row.status,
    allSpecsAccumulated: members.length > 0 && pending.length === 0,
    memberCount: members.length,
    accumulatedCount: accumulated.length,
    pendingMembers: pending,
    mainMergeSha: row.main_merge_sha,
    promotionHeld: row.promotion_held_reason,
  };
}

// ── The fast, question-shaped entry points ───────────────────────────────────

/**
 * "Why did spec X fail spec-review?" — instant. Returns Vale's tri-state, the durable-stamp state, and
 * Vale's needs_fix reasoning + named defects. Also catches the passed-but-unstamped legacy-disposition
 * bug (valePass=true yet reviewPassed=false), which silently holds the build in the claim-gate.
 */
export async function whyDidSpecReviewFail(workspaceId: string, slug: string): Promise<ReviewState> {
  const admin = createAdminClient();
  const [raw, needsFix] = await Promise.all([
    getSpecRow(workspaceId, slug),
    readNeedsFix(admin, workspaceId, slug),
  ]);
  const valePass = raw?.vale_pass ?? null;
  const reviewPassed = !!raw?.vale_review_passed_at;
  let verdict: ReviewState["verdict"];
  if (valePass === false) verdict = "needs_fix";
  else if (valePass === null && !reviewPassed) verdict = "never_reviewed";
  else if (valePass === true && !reviewPassed) verdict = "passed_but_unstamped";
  else verdict = "passed";
  return {
    valePass,
    reviewPassed,
    needsFixReason: needsFix.reason,
    defects: needsFix.defects,
    verdict,
  };
}

/**
 * "What is spec X waiting on?" — the needs_input / needs_approval / blocker / serialization investigator.
 * Reports the parked question or gated action, who it's routed to, and how long it's been waiting.
 */
export async function whatIsSpecWaitingOn(workspaceId: string, slug: string): Promise<WaitingState> {
  const admin = createAdminClient();
  const [job, timecard, raw] = await Promise.all([
    getLiveJobForSlug(workspaceId, slug, admin),
    getTimecard(admin, workspaceId, slug),
    getSpecRow(workspaceId, slug),
  ]);
  // Fast path: if the live job is itself parked, the wait is known — skip the expensive workspace-wide
  // blocker resolution (getSpecBlockers loads the spec set + goal-membership map).
  const PARK: ReadonlySet<string> = new Set(["needs_input", "needs_approval", "blocked_on_usage", "held", "dismissed", "needs_attention"]);
  if (job && PARK.has(job.status as string)) return deriveWaiting(job, timecard, []);
  // A folded/deferred spec is terminal — not waiting on anything; skip the costly blocker resolution.
  if (raw?.status === "folded" || raw?.status === "deferred") {
    return { waiting: false, kind: "none", detail: `Terminal (${raw.status}) — not waiting.`, prompts: [], waitingOn: null, sinceMs: null };
  }
  // Only resolve blocker CLEARANCE (the costly read) when the spec actually declares blockers — the raw
  // `blocked_by` array is already on the spec row, so an unblocked spec pays nothing.
  const hasBlockers = (raw?.blocked_by?.length ?? 0) > 0;
  const blockers = hasBlockers ? await getSpecBlockersSafe(slug) : [];
  return deriveWaiting(job, timecard, blockers);
}

/** getSpecBlockers lives in brain-roadmap (single-arg, workspace-inferred); wrap it so a failure never
 *  crashes the investigator (blocker resolution reaches into provenance + goals). */
async function getSpecBlockersSafe(slug: string): Promise<{ slug: string; cleared: boolean }[]> {
  try {
    const { getSpecBlockers } = await import("./brain-roadmap");
    const b = await getSpecBlockers(slug);
    return (b ?? []).map((x) => ({ slug: x.slug, cleared: x.cleared }));
  } catch {
    return [];
  }
}

function deriveWaiting(
  job: AgentJob | null,
  timecard: TimecardView,
  blockers: { slug: string; cleared: boolean }[],
): WaitingState {
  const openWait: TimecardOpenWait | undefined = timecard.open_waits[timecard.open_waits.length - 1];
  const uncleared = blockers.filter((b) => !b.cleared).map((b) => b.slug);

  if (job) {
    // agent_jobs.status is free-text at runtime (held / dismissed / blocked_on_usage exist) but the AgentJob
    // TS union is narrower — compare on a string view so every real park state is reachable.
    const st: string = job.status;
    const naClass = (job as { needs_attention_class?: string | null }).needs_attention_class ?? null;
    const sinceMs = msSince(job.updated_at) ?? (openWait ? openWait.gap_ms : null);
    const prompts = promptsOf(job);
    if (st === "needs_input") {
      return {
        waiting: true,
        kind: "needs_input",
        detail: `Build is parked awaiting input: ${prompts[0] ?? "(question payload)"}`,
        prompts,
        waitingOn: openWait?.waiting_on ?? "owner",
        sinceMs,
      };
    }
    if (st === "needs_approval") {
      return {
        waiting: true,
        kind: "needs_approval",
        detail: `Build is parked awaiting approval: ${prompts[0] ?? "(gated action)"}`,
        prompts,
        waitingOn: openWait?.waiting_on ?? "owner/CEO",
        sinceMs,
      };
    }
    if (st === "blocked_on_usage") {
      return { waiting: true, kind: "usage_cap", detail: "All Max accounts are at the 5-hour cap; auto-requeues when one clears.", prompts: [], waitingOn: "max_cap", sinceMs };
    }
    if (st === "held") {
      return { waiting: true, kind: "held", detail: "Held by the director sequence-reconcile (out-of-order milestone build).", prompts: [], waitingOn: "director", sinceMs };
    }
    if (st === "dismissed") {
      return { waiting: true, kind: "dismissed", detail: "Dismiss-parked by the director (CEO-reversible).", prompts: [], waitingOn: "director", sinceMs };
    }
    if (st === "needs_attention") {
      return { waiting: true, kind: "needs_attention", detail: `Parked needs_attention${naClass ? ` (${naClass})` : ""}.`, prompts, waitingOn: "owner", sinceMs };
    }
  }

  if (uncleared.length) {
    return {
      waiting: true,
      kind: "blocked_by",
      detail: `Blocked by unshipped prerequisite spec(s): ${uncleared.join(", ")}.`,
      prompts: [],
      waitingOn: uncleared[0],
      sinceMs: openWait ? openWait.gap_ms : null,
    };
  }

  if (openWait) {
    return {
      waiting: true,
      kind: openWait.wait_kind === "blocked_on_dependency" ? "blocked_by" : "needs_input",
      detail: `Open wait span: ${openWait.wait_kind}${openWait.waiting_on ? ` on ${openWait.waiting_on}` : ""}.`,
      prompts: [],
      waitingOn: openWait.waiting_on,
      sinceMs: openWait.gap_ms,
    };
  }

  return { waiting: false, kind: "none", detail: "Not waiting on anything — either progressing or terminal.", prompts: [], waitingOn: null, sinceMs: null };
}

function promptsOf(job: AgentJob): string[] {
  const out: string[] = [];
  for (const q of job.questions ?? []) {
    if (q && typeof q === "object" && "text" in q && (q as { text?: unknown }).text) out.push(String((q as { text: unknown }).text));
  }
  for (const a of job.pending_actions ?? []) {
    const obj = a as { summary?: string; reason?: string; description?: string };
    const label = obj?.summary ?? obj?.reason ?? obj?.description;
    if (label) out.push(String(label));
  }
  return out;
}

/**
 * "Why isn't spec X building?" — the queued-but-not-claimed answer. Ranks the reasons a spec is not on a
 * build lane right now: shipped/folded/deferred (terminal), an uncleared blocker, not review-passed,
 * goal-member serialization, a parked job, a usage cap, no build job at all, or a saturated lane pool.
 */
export async function whyIsSpecNotBuilding(workspaceId: string, slug: string): Promise<NotBuildingReason> {
  const [d, lanes] = await Promise.all([diagnoseSpec(workspaceId, slug), getLaneOccupancy(workspaceId)]);
  if (!d) {
    // Folded/archived specs are off the board — answer from the raw row instead of "unknown".
    const raw = await getSpecRow(workspaceId, slug);
    if (!raw) return { building: false, reason: "unknown", detail: `No spec row for ${slug} (phantom).`, suggestedAction: null };
    if (raw.status === "folded") return { building: false, reason: "folded", detail: "Folded/archived — terminal, shipped to main.", suggestedAction: null };
    return { building: false, reason: "unknown", detail: `Off the board (raw status ${raw.status ?? "derived"}).`, suggestedAction: null };
  }

  const liveBuild = d.jobs.find((j) => j.kind === "build");
  const suggested = d.stuck.suggestedAction;

  if (liveBuild && (liveBuild.status === "building" || liveBuild.status === "claimed")) {
    return { building: true, reason: "building", detail: `Build job is ${liveBuild.status}.`, suggestedAction: null };
  }
  if (d.derivedStatus === "shipped") return { building: false, reason: "shipped", detail: "Already shipped.", suggestedAction: null };
  if (d.derivedStatus === "folded") return { building: false, reason: "folded", detail: "Already folded.", suggestedAction: null };
  if (d.derivedStatus === "deferred") return { building: false, reason: "deferred", detail: "Deferred (parked out of the build queue).", suggestedAction: suggested };
  if (d.blockedByOpen.length) {
    return { building: false, reason: "blocked_by", detail: `Blocked by: ${d.blockedByOpen.map((b) => b.slug).join(", ")}.`, suggestedAction: suggested };
  }
  if (!d.valeReviewPassed && d.derivedStatus === "in_review") {
    return { building: false, reason: "not_review_passed", detail: "Has not passed Vale spec-review (vale_review_passed_at is null), so the build claim-gate holds it.", suggestedAction: suggested };
  }
  if (liveBuild?.status === "needs_input") return { building: false, reason: "parked_needs_input", detail: `Parked awaiting input: ${liveBuild.pendingPrompts[0] ?? "(question)"}.`, suggestedAction: "Answer the question in the roadmap inbox." };
  if (liveBuild?.status === "needs_approval") return { building: false, reason: "parked_needs_approval", detail: `Parked awaiting approval: ${liveBuild.pendingPrompts[0] ?? "(gated action)"}.`, suggestedAction: "Approve/decline in the roadmap inbox." };
  if (liveBuild?.status === "blocked_on_usage") return { building: false, reason: "usage_cap", detail: "All Max accounts capped; auto-requeues.", suggestedAction: null };

  // Goal-member serialization: a queued build whose claim is held because a goal-mate is in-flight.
  const goalSlug = d.goalSlug ?? (await resolveGoalSlugForSpec(workspaceId, slug));
  if (goalSlug && liveBuild && liveBuild.status === "queued") {
    const serialized = /goal-member|serialized|goal serializer|hot-file/i.test(liveBuild.logTail ?? "");
    if (serialized) {
      return { building: false, reason: "goal_member_serialized", detail: "Queued but held by the intra-goal serializer — a goal-mate build is in-flight.", suggestedAction: "Wait for the in-flight goal-mate to finish, or investigate a serializer deadlock." };
    }
  }

  if (!liveBuild) {
    // goal-serializer-one-decision-point-and-serial-claim-no-queued-deadlock Phase 3 —
    // ready-goal-never-frozen invariant. When this spec has no build job at all AND is a member
    // of a goal, check whether the goal's earliest-ready head is missing (the persistent
    // 2026-07-16 dahlia state). If so, surface the diagnostic AND fire the auto-break (it has
    // its own 3-min cooldown so a rapid re-check doesn't hammer director_activity). The
    // auto-break writes a director_activity audit row + enqueues the earliest via
    // `enqueueBuildIfDue` with `bypassGoalMemberAdmission:true`. Best-effort — a resolver/DB
    // blip returns verdict:'ok' from the wrapper, and this code falls through to the existing
    // no_build_job reason below.
    if (goalSlug) {
      const invariant = await assertReadyGoalNeverFrozenAndAutoBreak(workspaceId, goalSlug);
      if (invariant.verdict === "deadlock") {
        const detail = invariant.autoBroken
          ? `Ready-goal-never-frozen invariant TRIGGERED on goal ${goalSlug}: earliest ready head '${invariant.earliest}' had no in-flight build row. Auto-break enqueued ${invariant.earliest}.`
          : `Ready-goal-never-frozen invariant TRIGGERED on goal ${goalSlug}: earliest ready head '${invariant.earliest}' had no in-flight build row; auto-break did NOT land (${invariant.autoBreakReason ?? "reason unknown"}).`;
        return {
          building: false,
          reason: "ready_goal_deadlock",
          detail,
          suggestedAction: invariant.autoBroken ? null : `Manually re-enqueue ${invariant.earliest} — the earliest ready goal-member of ${goalSlug}.`,
        };
      }
    }
    // No build job at all + eligible → the chain never enqueued it (an outlier stall).
    return { building: false, reason: "no_build_job", detail: "No build job exists for this spec, yet it is not terminal/blocked — the chain likely never enqueued it (re-drive candidate).", suggestedAction: "Re-fire queueNextChainedPhase / re-queue the build." };
  }

  if (liveBuild.status === "queued" && lanes.activeBuilds >= lanes.buildPoolSize) {
    return { building: false, reason: "lane_saturated", detail: `Queued behind a full build pool (${lanes.activeBuilds}/${lanes.buildPoolSize} lanes busy).`, suggestedAction: null };
  }

  return { building: false, reason: liveBuild.status === "queued" ? "no_build_job" : "unknown", detail: `Build job status is '${liveBuild.status}'.`, suggestedAction: suggested };
}

/** The fix phases auto-appended to this spec by the pre-merge spec-test / security fail path. */
export async function investigateFixPhases(workspaceId: string, slug: string): Promise<FixPhaseInfo[]> {
  const raw = await getSpecRow(workspaceId, slug);
  const phases: SpecPhaseRow[] = raw?.phases ?? [];
  return phases
    .filter((p) => p.kind === "fix")
    .map((p) => ({
      index: p.position,
      title: p.title,
      status: p.status,
      built: !!p.build_sha,
      build_sha: p.build_sha,
      merge_sha: p.merge_sha,
      originCheckKeys: p.origin_check_keys ?? [],
    }));
}

/** The merged "what happened to this spec" timeline: director_activity actions + timecard lifecycle steps. */
export async function getSpecTimeline(workspaceId: string, slug: string, limit = 40): Promise<TimelineEvent[]> {
  const admin = createAdminClient();
  const [activity, timecard] = await Promise.all([
    readDirectorActivity(admin, workspaceId, slug, limit),
    getTimecard(admin, workspaceId, slug),
  ]);
  const stepEvents: TimelineEvent[] = timecard.steps.map((s) => ({
    at: s.at,
    source: "timecard" as const,
    kind: s.event_kind,
    actor: s.actor,
    detail: s.phase_index != null ? `phase ${s.phase_index}` : null,
    metadata: s.metadata ?? {},
  }));
  return [...activity, ...stepEvents].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

/**
 * THE full lifecycle snapshot for one spec — the "everything" call the detail-view / Mario uses.
 * Works for a folded/archived spec too: when the board diagnosis is unavailable (folded → off the
 * board) it degrades to the raw-reader data (review reasoning + timeline + fix phases + goal), so a
 * retrospective "what happened to this spec" still answers. Returns null only when the slug has no
 * spec row at all (a true phantom).
 */
export async function investigateSpec(workspaceId: string, slug: string): Promise<SpecInvestigation | null> {
  const admin = createAdminClient();
  const [d, raw, job, timecard, needsFix, activity] = await Promise.all([
    diagnoseSpec(workspaceId, slug),
    getSpecRow(workspaceId, slug),
    getLiveJobForSlug(workspaceId, slug, admin),
    getTimecard(admin, workspaceId, slug),
    readNeedsFix(admin, workspaceId, slug),
    readDirectorActivity(admin, workspaceId, slug, 40),
  ]);
  // A true phantom — no board diagnosis AND no raw row — is not investigable.
  if (!d && !raw) return null;
  const folded = !d && !!raw;
  // Resolve blocker CLEARANCE only when the spec is live AND declares blockers (a folded/terminal spec
  // isn't waiting; the raw array gates the costly workspace-wide read for the rest).
  const blockers = !folded && (raw?.blocked_by?.length ?? 0) > 0 ? await getSpecBlockersSafe(slug) : [];

  const valePass = raw?.vale_pass ?? null;
  const reviewPassed = d ? d.valeReviewPassed : !!raw?.vale_review_passed_at;
  let verdict: ReviewState["verdict"];
  if (valePass === false) verdict = "needs_fix";
  else if (valePass === null && !reviewPassed) verdict = "never_reviewed";
  else if (valePass === true && !reviewPassed) verdict = "passed_but_unstamped";
  else verdict = "passed";

  const review: ReviewState = { valePass, reviewPassed, needsFixReason: needsFix.reason, defects: needsFix.defects, verdict };

  const fixPhases: FixPhaseInfo[] = (raw?.phases ?? [])
    .filter((p) => p.kind === "fix")
    .map((p) => ({ index: p.position, title: p.title, status: p.status, built: !!p.build_sha, build_sha: p.build_sha, merge_sha: p.merge_sha, originCheckKeys: p.origin_check_keys ?? [] }));

  const stepEvents: TimelineEvent[] = timecard.steps.map((s) => ({ at: s.at, source: "timecard" as const, kind: s.event_kind, actor: s.actor, detail: s.phase_index != null ? `phase ${s.phase_index}` : null, metadata: s.metadata ?? {} }));
  const timeline = [...activity, ...stepEvents].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40);

  const goalSlug = d?.goalSlug ?? (raw?.milestone_id ? await resolveGoalSlugForSpec(workspaceId, slug) : null);
  const goal = goalSlug ? await getGoalContext(workspaceId, goalSlug) : null;

  const headline = d
    ? { stuck: d.stuck.isStuck, severity: d.stuck.severity, reason: d.stuck.reason, suggestedAction: d.stuck.suggestedAction }
    : { stuck: false, severity: "none" as Severity, reason: "Folded/archived — terminal, off the board.", suggestedAction: null };

  return { slug, diagnosis: d, folded, review, waiting: deriveWaiting(job, timecard, blockers), fixPhases, timecard, timeline, goal, headline };
}

// ── Goal-level investigation ─────────────────────────────────────────────────

export interface GoalMemberSummary {
  slug: string;
  derivedStatus: string;
  onGoalBranch: boolean;
  promoteEligible: boolean;
  promoteReason: string | null;
  stuck: boolean;
  stuckReason: string;
}

export interface GoalInvestigation {
  goalSlug: string;
  status: string;
  milestones: { position: number; title: string }[];
  accumulation: GoalContext;
  members: GoalMemberSummary[];
}

/**
 * "Investigate goal X" — is it accumulating all its specs, which members are stuck, and is it ready for
 * (or held on) the atomic goal→main promotion.
 */
export async function investigateGoal(workspaceId: string, goalSlug: string): Promise<GoalInvestigation | null> {
  const [row, accumulation, branch] = await Promise.all([
    getGoalRow(workspaceId, goalSlug),
    getGoalContext(workspaceId, goalSlug),
    goalBranchState(workspaceId, goalSlug),
  ]);
  if (!row || !accumulation) return null;

  // Diagnose ONLY this goal's members (slug-scoped, in parallel) — never a full-workspace scan. A folded
  // member has no board diagnosis; fall back to its goal-branch entry so the goal view still lists it.
  const branchBySlug = new Map((branch.specs ?? []).map((s) => [s.slug, s]));
  const memberSlugs = (branch.specs ?? []).map((m) => m.slug);
  const members: GoalMemberSummary[] = await Promise.all(
    memberSlugs.map(async (memberSlug): Promise<GoalMemberSummary> => {
      const [m, elig] = await Promise.all([
        diagnoseSpec(workspaceId, memberSlug),
        isSpecPromoteEligible(workspaceId, memberSlug, `claude/build-${memberSlug}`).catch(
          () => null as SpecPromoteEligibility | null,
        ),
      ]);
      const bs = branchBySlug.get(memberSlug);
      return {
        slug: memberSlug,
        derivedStatus: m ? m.derivedStatus : bs?.status ?? "folded",
        onGoalBranch: m ? m.onGoalBranch : bs?.onGoalBranch ?? false,
        promoteEligible: elig?.eligible ?? false,
        promoteReason: elig && !elig.eligible ? elig.reason ?? null : null,
        stuck: m ? m.stuck.isStuck : false,
        stuckReason: m ? m.stuck.reason : "Folded/archived — terminal.",
      };
    }),
  );

  const milestones: GoalMilestoneRow[] = row.milestones ?? [];
  return {
    goalSlug,
    status: row.status,
    milestones: milestones.map((ms) => ({ position: ms.position, title: ms.title })),
    accumulation,
    members,
  };
}
