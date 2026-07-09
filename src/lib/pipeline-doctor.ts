/**
 * pipeline-doctor — an INSTANT, read-only diagnosis of the whole spec pipeline.
 *
 * The CEO's "what's stuck and WHY?" probe, packaged once so every session reads the SAME derived
 * truth instead of hand-writing ad-hoc SQL. For each board spec it assembles the **derived status**
 * (the canonical roadmap rollup), the per-phase build/ship provenance, the latest job per lifecycle
 * kind, the spec-test + security rollups, the lifecycle gate it's parked at, and a `stuck` verdict
 * produced by a set of named, extensible anomaly classifiers (the WHY).
 *
 * ⚠️ READ-ONLY by construction. This module NEVER writes — no status flips, no enqueues, no DB
 * mutations of any kind. It COMPOSES the existing canonical readers ([[brain-roadmap]] `getRoadmap`
 * → derived status; [[agent-jobs]] readers; [[spec-test-runs]] / [[security-agent]] rollups;
 * [[build-lifecycle]] `deriveLifecycleStage`) so it can never DRIFT from the board — a raw
 * re-derivation would. The derived status is the source of truth.
 *
 * Entry point: `diagnosePipeline(opts?)`. CLI wrapper: `scripts/pipeline-status.ts`.
 */
import type { SpecCard, SpecStatus, Phase } from "@/lib/brain-roadmap";
import { getRoadmap, getSpec as getSpecCard } from "@/lib/brain-roadmap";
import type { AgentJob } from "@/lib/agent-jobs";
import { getLatestJobsBySlug, ACTIVE_STATUSES, resolveGoalSlugForSpec } from "@/lib/agent-jobs";
import type { SpecTestRun, AgentVerdict, HumanCheckRow } from "@/lib/spec-test-runs";
import { getLatestSpecTestRuns, getLiveSpecTestSlugs, getHumanCheckResolutions, normalizeRun, hasActiveSpecTestJob } from "@/lib/spec-test-runs";
import type { SecurityStateBySlug } from "@/lib/security-agent";
import { getSecurityStateBySlug, getSecurityStateForSlug } from "@/lib/security-agent";
import { buildLifecycleContext, specTestHasOpenRegression } from "@/lib/build-lifecycle-context";
import { deriveLifecycleStage } from "@/lib/build-lifecycle";
import type { LifecycleDerivation } from "@/lib/build-lifecycle";

// The reaper's staleness window (scripts/builder-worker.ts REAP_STALE_MS = 20 min). A `building`/`claimed`
// session whose heartbeat is older than this is DEAD — the reaper re-queues/escalates it. We flag it as a
// zombie at the same threshold so the doctor agrees with the reaper.
const ZOMBIE_STALE_MIN = 20;
// The build/plan pool ceiling (scripts/builder-worker.ts MAX_CONCURRENT). Surfaced as lane context so a
// `planned` spec that's sitting reads "stuck" vs "just queued behind a full pool".
const BUILD_POOL_SIZE = 8;

// ── Severity ladder ──────────────────────────────────────────────────────────
export type Severity = "none" | "info" | "low" | "medium" | "high" | "critical";
const SEVERITY_RANK: Record<Severity, number> = { none: 0, info: 1, low: 2, medium: 3, high: 4, critical: 5 };

// The lifecycle kinds whose latest job we surface per spec. Typed as strings because `spec-test` is a real
// runtime kind (enqueued by enqueueSpecTestIfDue) that the `JobKind` union doesn't yet list.
const RELEVANT_JOB_KINDS: readonly string[] = ["build", "spec-test", "security-review", "fold", "goal-fold"];

// ── Output shapes ────────────────────────────────────────────────────────────

export interface PhaseDiag {
  index: number; // 1-based
  title: string;
  status: Phase;
  build_sha: string | null;
  merge_sha: string | null;
  pr: number | null;
}

export interface JobDiag {
  kind: string;
  status: string;
  branch: string | null;
  prNumber: number | null;
  /** Minutes since the row was last touched (`updated_at`). */
  ageMinutes: number | null;
  /** Minutes since the live session last bumped `last_heartbeat_at` (null when the row never heartbeated). */
  heartbeatAgeMinutes: number | null;
  needsAttentionClass: string | null;
  error: string | null;
  logTail: string | null;
  /** The questions/pending-action prompts a needs_input/needs_approval job is waiting on. */
  pendingPrompts: string[];
  updatedAt: string;
}

export interface SpecTestDiag {
  verdict: AgentVerdict;
  summary: { auto_pass: number; auto_fail: number; needs_human: number; inconclusive: number };
  branch: string | null;
  hasOpenRegression: boolean;
  ageMinutes: number | null;
}

export interface DetectorResult {
  /** Stable classifier id (e.g. `stuck-in-testing`). */
  name: string;
  severity: Severity;
  /** A crisp human sentence: what's wrong + the load-bearing facts. */
  reason: string;
  /** The single next move that would unstick it. */
  suggestedAction: string;
  /** How long it's been in this state (minutes), when knowable. */
  sinceMinutes: number | null;
}

export interface StuckVerdict {
  isStuck: boolean;
  severity: Severity;
  /** The primary (highest-severity) matched detector, or null when healthy. */
  detector: string | null;
  reason: string;
  sinceMinutes: number | null;
  suggestedAction: string | null;
}

export interface SpecDiagnosis {
  slug: string;
  title: string;
  owner: string | null;
  parent: string | null;
  /** The goal this spec is bound to (via `specs.milestone_id`), or null for a one-off spec. */
  goalSlug: string | null;
  /** The canonical DERIVED board status (from getRoadmap). */
  derivedStatus: SpecStatus | "folded";
  /** The RAW `specs.status` override column — null/in_review/deferred/folded are legal; a derived value here
   *  is the stored-status-override-violation bug. */
  rawStatus: string | null;
  critical: boolean;
  autoBuild: boolean; // false === opted out of auto-queue
  valeReviewPassed: boolean;
  blockedByOpen: { slug: string; status: Phase }[];
  onGoalBranch: boolean;
  phases: PhaseDiag[];
  jobs: JobDiag[];
  specTest: SpecTestDiag | null;
  security: (SecurityStateBySlug & { hasRecord: boolean }) | null;
  /** The lifecycle stage + gate the spec is parked at (the WHERE; the detectors give the WHY). */
  lifecycle: { stage: LifecycleDerivation["current"]; status: LifecycleDerivation["currentStatus"] };
  /** For a deferred spec — the audited defer reason + actor (from spec_status_history), when found. */
  deferAudit?: string;
  detectors: DetectorResult[];
  stuck: StuckVerdict;
}

export interface PipelineDiagnosis {
  workspaceId: string;
  generatedAt: string;
  totals: {
    total: number;
    stuck: number;
    healthy: number;
    awaitingHuman: number;
    bySeverity: Record<Severity, number>;
  };
  /** The first-class LOUD check: specs whose raw `specs.status` holds a derived value (override-only bug). */
  storedStatusViolations: SpecDiagnosis[];
  /** Build/plan pool occupancy context (for the not-claimed "stuck vs queued" call). */
  lanes: { buildPoolSize: number; activeBuilds: number };
  /** The diagnosed specs (stuck-first). Healthy specs included only when `includeHealthy` (or single-slug). */
  specs: SpecDiagnosis[];
}

export interface DiagnoseOptions {
  workspaceId?: string;
  includeHealthy?: boolean;
  /** Only count a spec as stuck when its anomaly is at least this many hours old (a staleness floor). */
  sinceHours?: number;
  /** Deep-dive a single spec — returns just that spec (always, healthy or not). */
  slug?: string;
}

// ── Internal: per-spec assembly context ──────────────────────────────────────

interface DoctorContext {
  workspaceId: string;
  now: number;
  /** Build/plan pool occupancy at scan time. */
  activeBuilds: number;
  /** sinceHours as minutes, or null for no floor. */
  staleFloorMin: number | null;
}

const DERIVED_STATUS_VALUES = new Set(["planned", "in_progress", "in_testing", "shipped", "rejected"]);

function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

function pendingPromptsOf(job: AgentJob): string[] {
  const out: string[] = [];
  for (const q of job.questions ?? []) {
    if (q && typeof q === "object" && "text" in q && q.text) out.push(String(q.text));
  }
  for (const a of job.pending_actions ?? []) {
    const obj = a as { summary?: string; reason?: string; description?: string };
    const label = obj?.summary ?? obj?.reason ?? obj?.description;
    if (label) out.push(String(label));
  }
  return out;
}

// ── The anomaly classifiers (the WHY) ────────────────────────────────────────
// Each is a named, pure function over the assembled SpecDiagnosis + context. It returns a DetectorResult
// when it matches, else null. The list is the extension point — add a classifier to grow the diagnosis.
// The primary `stuck` verdict is the highest-severity match (ties broken by list order).

type Classifier = (d: SpecDiagnosis, ctx: DoctorContext) => DetectorResult | null;

function latestBuildJob(d: SpecDiagnosis): JobDiag | null {
  return d.jobs.find((j) => j.kind === "build") ?? null;
}
function jobOfKind(d: SpecDiagnosis, kind: string): JobDiag | null {
  return d.jobs.find((j) => j.kind === kind) ?? null;
}
function anyPhaseBuilt(d: SpecDiagnosis): boolean {
  return d.phases.some((p) => !!p.build_sha || p.status === "shipped");
}
function specTestGreen(d: SpecDiagnosis): boolean {
  return !!d.specTest && d.specTest.verdict === "approved" && !d.specTest.hasOpenRegression;
}
function securityGreen(d: SpecDiagnosis): boolean {
  return !!d.security && d.security.completedClean && !d.security.surfaced && !d.security.live;
}

/** CRITICAL — the raw `specs.status` override column holds a DERIVED value. Per the brain the column is
 *  OVERRIDE-ONLY (in_review/deferred/folded/null); a stored derived value PINS the card over its derivation. */
const detectStoredStatusOverrideViolation: Classifier = (d) => {
  if (!d.rawStatus || !DERIVED_STATUS_VALUES.has(d.rawStatus)) return null;
  return {
    name: "stored-status-override-violation",
    severity: "critical",
    reason: `RAW specs.status='${d.rawStatus}' is a DERIVED value — the column is OVERRIDE-ONLY (in_review/deferred/folded/null). A stored derived value pins the card over its phase rollup (derived=${d.derivedStatus}).`,
    suggestedAction: `Clear the override: setSpecStatus(ws, '${d.slug}', null) so status derives from the phase rollup again.`,
    sinceMinutes: null,
  };
};

/** HIGH — an unresolved FAILED gate: a security review surfaced for the owner, OR the spec-test concluded
 *  with failures / an open regression. Surfaces the failure + log_tail. */
const detectFailedGate: Classifier = (d) => {
  // Security: a routed real-vuln fix / needs-human finding awaiting the owner.
  if (d.security?.surfaced) {
    const sec = jobOfKind(d, "security-review");
    return {
      name: "failed-gate",
      severity: "high",
      reason: `Security review SURFACED for the owner (a routed real-vuln fix or needs-human finding).${sec?.error ? ` error: ${sec.error}` : ""}${sec?.logTail ? ` …${sec.logTail.slice(-180)}` : ""}`,
      suggestedAction: "Clear the security finding in the Agents inbox (approve the fix or resolve the needs-human check) before this spec can promote.",
      sinceMinutes: sec?.ageMinutes ?? null,
    };
  }
  // Spec-test: a real machine failure (issues / error) or an unresolved auto-fail regression.
  if (d.specTest && (d.specTest.hasOpenRegression || d.specTest.verdict === "issues" || d.specTest.verdict === "error")) {
    const fails = d.specTest.summary.auto_fail;
    const stJob = jobOfKind(d, "spec-test");
    return {
      name: "failed-gate",
      severity: "high",
      reason: `Spec-test verdict='${d.specTest.verdict}'${fails ? ` (${fails} auto-fail check${fails === 1 ? "" : "s"})` : ""}${d.specTest.hasOpenRegression ? " with an UNRESOLVED open regression" : ""} — the fold/promote gate stays red.${stJob?.error ? ` error: ${stJob.error}` : ""}`,
      suggestedAction: "Author/queue a fix spec (or resolve the failing checks) — the green gate can't clear while a spec-test fail is unresolved.",
      sinceMinutes: d.specTest.ageMinutes,
    };
  }
  return null;
};

/** HIGH — a build/plan/spec-test session is `building`/`claimed` with a heartbeat older than the reaper
 *  threshold (~20m). The session is effectively dead; the reaper should re-queue or escalate it. */
const detectZombieSession: Classifier = (d) => {
  for (const j of d.jobs) {
    if (j.status !== "building" && j.status !== "claimed") continue;
    const staleMin = j.heartbeatAgeMinutes ?? j.ageMinutes;
    if (staleMin == null || staleMin < ZOMBIE_STALE_MIN) continue;
    return {
      name: "zombie-session",
      severity: "high",
      reason: `${j.kind} job is '${j.status}' but its ${j.heartbeatAgeMinutes != null ? "heartbeat" : "row"} is ${staleMin}m stale (reaper threshold ${ZOMBIE_STALE_MIN}m) — the session is dead.`,
      suggestedAction: "The stale-session reaper should re-queue or escalate it; if it's looping, park it needs_attention for a human.",
      sinceMinutes: staleMin,
    };
  }
  return null;
};

/** MEDIUM — a build is parked `needs_approval`/`needs_input` awaiting a human. Says WHO it's routed to +
 *  the question/reason. */
const detectAwaitingHuman: Classifier = (d) => {
  const j = d.jobs.find((x) => x.status === "needs_approval" || x.status === "needs_input");
  if (!j) return null;
  const who = d.owner ? `owner ${d.owner}` : "the CEO (no owner set)";
  const prompts = j.pendingPrompts.length ? ` Asking: "${j.pendingPrompts[0]}"` : j.needsAttentionClass ? ` (${j.needsAttentionClass})` : "";
  return {
    name: "awaiting-human",
    severity: "medium",
    reason: `${j.kind} job is '${j.status}', routed to ${who}.${prompts}`,
    suggestedAction: j.status === "needs_approval" ? "Approve/deny the gated action in the build console / Agents inbox." : "Answer the open question in the build console so the session resumes.",
    sinceMinutes: j.ageMinutes,
  };
};

/** HIGH — status=in_testing, spec-test GREEN + security GREEN, but never promoted to main/goal-branch.
 *  Reports WHICH gate didn't fire (one-off → auto-merge to main; goal-bound → spec→goal-branch promotion). */
const detectStuckInTesting: Classifier = (d) => {
  if (d.derivedStatus !== "in_testing") return null;
  if (!specTestGreen(d) || !securityGreen(d)) return null; // a non-green in_testing spec is a failed/awaiting case
  const buildJob = latestBuildJob(d);
  const sinceMin = d.specTest?.ageMinutes ?? buildJob?.ageMinutes ?? null;
  if (d.goalSlug) {
    if (!d.onGoalBranch) {
      return {
        name: "stuck-in-testing",
        severity: "high",
        reason: `in_testing, spec-test + security BOTH green, all phases accumulated — but goal-bound (${d.goalSlug}) and NOT on its goal branch. The spec→goal-branch promotion (Gate B, promoteEligibleSpecsToGoalBranch) hasn't fired.`,
        suggestedAction: `Run the goal-branch promotion poll (or check for a merge conflict on goal/${d.goalSlug}); the spec is promote-eligible but unmerged onto its goal branch.`,
        sinceMinutes: sinceMin,
      };
    }
    return {
      name: "stuck-in-testing",
      severity: "high",
      reason: `in_testing + on its goal branch (${d.goalSlug}), green on both gates — waiting for the goal's atomic promotion to main (Gate C). The goal hasn't promoted yet.`,
      suggestedAction: `Check goal '${d.goalSlug}' completeness (every member spec on the goal branch) and the goal→main promotion poll.`,
      sinceMinutes: sinceMin,
    };
  }
  // One-off spec: should auto-merge its claude/build-* branch to main (Gate A).
  return {
    name: "stuck-in-testing",
    severity: "high",
    reason: `in_testing, spec-test + security BOTH green, one-off spec — but the branch never auto-merged to main (Gate A). No phase carries a merge_sha.`,
    suggestedAction: "Check the auto-merge gate (autoMergeReadyPrs) for this branch — it's promote-eligible but its PR hasn't squash-merged.",
    sinceMinutes: sinceMin,
  };
};

/** MEDIUM — status=in_testing but the spec-test verdict is `needs_human` (advisory, not an auto-green pass),
 *  so the promote gate can't go green until a human resolves it. */
const detectInTestingNeedsHuman: Classifier = (d) => {
  if (d.derivedStatus !== "in_testing") return null;
  if (!d.specTest || d.specTest.verdict !== "needs_human") return null;
  if (d.security?.surfaced) return null; // failed-gate owns that
  return {
    name: "in-testing-needs-human",
    severity: "medium",
    reason: `in_testing, but the spec-test verdict is 'needs_human' (${d.specTest.summary.needs_human} human check${d.specTest.summary.needs_human === 1 ? "" : "s"}) — an advisory verdict, not an auto-green machine pass, so the promote gate won't clear on its own.`,
    suggestedAction: "Resolve the needs-human spec-test check(s) on Developer → Spec Tests (verify/fail/dismiss) so the gate can derive green or red.",
    sinceMinutes: d.specTest.ageMinutes,
  };
};

/** HIGH — status=in_progress AND the latest build job completed/merged, but no phase advanced (no build_sha
 *  stamped). The build ran but its provenance never landed on the phases. */
const detectBuiltNotStamped: Classifier = (d) => {
  if (d.derivedStatus !== "in_progress") return null;
  const build = latestBuildJob(d);
  if (!build || (build.status !== "completed" && build.status !== "merged")) return null;
  if (anyPhaseBuilt(d)) return null; // some phase carries a build_sha / is shipped — it DID advance
  return {
    name: "built-not-stamped",
    severity: "high",
    reason: `Latest build job is '${build.status}' (branch ${build.branch ?? "?"}) but NO phase carries a build_sha — the build ran yet stampPhaseBuilt never advanced any phase. Phases: ${d.phases.map((p) => p.status).join("/") || "(none)"}.`,
    suggestedAction: "Re-check the build's post-commit stamp (stampPhaseBuilt) — the branch built but the phase rollup is stuck at planned/in_progress, so it'll never reach accumulation-complete.",
    sinceMinutes: build.ageMinutes,
  };
};

/** MEDIUM — a phase is marked shipped without any PR/merge provenance (drift). */
const detectDriftSuspect: Classifier = (d) => {
  const bad = d.phases.filter((p) => p.status === "shipped" && !p.pr && !p.merge_sha);
  if (!bad.length) return null;
  return {
    name: "drift-suspect",
    severity: "medium",
    reason: `${bad.length} phase(s) marked shipped with NO PR/merge_sha provenance (phase${bad.length === 1 ? "" : "s"} ${bad.map((p) => p.index).join(", ")}) — shipped-without-provenance is a drift signal.`,
    suggestedAction: "Reconcile the phase provenance (reconcileMergedSpecPhases / audit-spec-shipped-state) — a shipped phase must carry the merge SHA that shipped it.",
    sinceMinutes: null,
  };
};

/** LOW/MEDIUM — status=planned, reviewed, unblocked, auto_build on, no active build — yet sitting. Notes pool state. */
const detectNotClaimed: Classifier = (d, ctx) => {
  if (d.derivedStatus !== "planned") return null;
  if (!d.autoBuild) return null; // opted out — sitting is intentional
  if (!d.valeReviewPassed) return null; // hasn't cleared Vale — correctly not claimed yet
  if (d.blockedByOpen.length) return null; // genuinely blocked
  const build = latestBuildJob(d);
  if (build && ACTIVE_STATUSES.includes(build.status as never)) return null; // a build is live
  const poolFull = ctx.activeBuilds >= BUILD_POOL_SIZE;
  return {
    name: "not-claimed",
    severity: poolFull ? "low" : "medium",
    reason: `planned, Vale-passed, unblocked, auto_build on, no active build — ${poolFull ? `but the build pool is FULL (${ctx.activeBuilds}/${BUILD_POOL_SIZE}); likely just queued` : `and the build pool has room (${ctx.activeBuilds}/${BUILD_POOL_SIZE}) — it should have been claimed`}.`,
    suggestedAction: poolFull ? "Likely just waiting for a free lane — re-check after a build finishes." : "Check the director init/groom lane + claim-time build gate; a free-lane planned spec should be building.",
    sinceMinutes: null,
  };
};

/** INFO — status=deferred. Surfaces the audited defer reason + who (from spec_status_history). */
const detectDeferredParked: Classifier = (d) => {
  if (d.derivedStatus !== "deferred") return null;
  return {
    name: "deferred-parked",
    severity: "info",
    reason: `Deferred (parked in its own column, excluded from every auto-build lane).${d.deferAudit ? ` ${d.deferAudit}` : " (no audit row found — check this was a CEO action, not a silent programmatic park.)"}`,
    suggestedAction: "Un-defer from the roadmap board (→ Planned) when ready; deferred is a CEO choice, not a worker punt.",
    sinceMinutes: null,
  };
};

// The ordered registry. Add a classifier here to extend the diagnosis.
export const CLASSIFIERS: Classifier[] = [
  detectStoredStatusOverrideViolation,
  detectFailedGate,
  detectZombieSession,
  detectStuckInTesting,
  detectBuiltNotStamped,
  detectInTestingNeedsHuman,
  detectAwaitingHuman,
  detectDriftSuspect,
  detectNotClaimed,
  detectDeferredParked,
];

// ── Assembly ─────────────────────────────────────────────────────────────────

/** The narrow raw `specs` columns the doctor reads directly (everything else comes from the canonical
 *  readers). This is the ONE targeted query the brain's stored-status-override check requires. */
interface RawSpecRow {
  slug: string;
  status: string | null;
  milestone_id: string | null;
  deferred: boolean | null;
}

function buildJobDiags(jobsForSlug: AgentJob[], now: number): JobDiag[] {
  // Latest job per relevant kind (rows arrive newest-first).
  const latestByKind = new Map<string, AgentJob>();
  for (const j of jobsForSlug) {
    if (!RELEVANT_JOB_KINDS.includes(j.kind)) continue;
    if (!latestByKind.has(j.kind)) latestByKind.set(j.kind, j);
  }
  const out: JobDiag[] = [];
  for (const kind of RELEVANT_JOB_KINDS) {
    const j = latestByKind.get(kind);
    if (!j) continue;
    const raw = j as AgentJob & { last_heartbeat_at?: string | null; needs_attention_class?: string | null };
    out.push({
      kind: j.kind,
      status: j.status,
      branch: j.spec_branch,
      prNumber: j.pr_number,
      ageMinutes: minutesSince(j.updated_at, now),
      heartbeatAgeMinutes: minutesSince(raw.last_heartbeat_at, now),
      needsAttentionClass: raw.needs_attention_class ?? null,
      error: j.error || null,
      logTail: j.log_tail || null,
      pendingPrompts: pendingPromptsOf(j),
      updatedAt: j.updated_at,
    });
  }
  return out;
}

function assembleSpec(
  card: SpecCard,
  raw: RawSpecRow | undefined,
  jobsForSlug: AgentJob[],
  run: SpecTestRun | null,
  liveSpecTestSlugs: ReadonlySet<string>,
  security: SecurityStateBySlug | undefined,
  humanResolutions: Map<string, HumanCheckRow>,
  goalSlug: string | null,
  deferAudit: string | undefined,
  ctx: DoctorContext,
): SpecDiagnosis {
  const phases: PhaseDiag[] = card.phases.map((p, i) => ({
    index: i + 1,
    title: p.title,
    status: p.status,
    build_sha: p.build_sha ?? null,
    merge_sha: p.merge_sha ?? null,
    pr: p.pr ?? null,
  }));

  const specTest: SpecTestDiag | null = run
    ? {
        verdict: run.agent_verdict,
        summary: run.summary,
        branch: run.spec_branch,
        hasOpenRegression: specTestHasOpenRegression(card.slug, run, humanResolutions),
        ageMinutes: minutesSince(run.run_at, ctx.now),
      }
    : null;

  // Lifecycle gate (the WHERE). Compose the canonical derivation off the same board signals.
  const lifecycleCtx = buildLifecycleContext({
    spec: card,
    job: jobsForSlug.find((j) => j.kind === "build") ?? jobsForSlug[0] ?? null,
    testRun: run,
    humanResolutions,
    liveSpecTestSlugs,
    security,
    folded: (card.status as SpecStatus | "folded") === "folded",
  });
  const lifecycle = deriveLifecycleStage(lifecycleCtx);

  const d: SpecDiagnosis = {
    slug: card.slug,
    title: card.title,
    owner: card.owner ?? null,
    parent: card.parent ?? null,
    goalSlug,
    derivedStatus: card.status,
    rawStatus: raw?.status ?? null,
    critical: !!card.critical,
    autoBuild: card.autoBuild !== false,
    valeReviewPassed: !!card.valeReviewPassed,
    blockedByOpen: card.blockedBy.filter((b) => !b.cleared).map((b) => ({ slug: b.slug, status: b.status })),
    onGoalBranch: !!card.onGoalBranch,
    phases,
    jobs: buildJobDiags(jobsForSlug, ctx.now),
    specTest,
    security: security ? { ...security, hasRecord: true } : null,
    lifecycle: { stage: lifecycle.current, status: lifecycle.currentStatus },
    deferAudit,
    detectors: [],
    stuck: { isStuck: false, severity: "none", detector: null, reason: "", sinceMinutes: null, suggestedAction: null },
  };

  // Run every classifier; collect matches.
  const results: DetectorResult[] = [];
  for (const classify of CLASSIFIERS) {
    const r = classify(d, ctx);
    if (r) results.push(r);
  }
  d.detectors = results;

  // Primary verdict = highest-severity match. Two classes are surfaced but NOT counted as "stuck":
  //  - `deferred-parked` — deferred is a deliberate CEO choice, the only legitimate non-flowing state;
  //  - `awaiting-human` — a healthy pause that needs a human, not a stall.
  // A DEFERRED spec is never "stuck" regardless of any other (e.g. failed-gate) signal it carries — the
  // CEO parked it on purpose; its other detectors still show in the deep-dive / --all, just not as a stall.
  const NON_STUCK = new Set(["deferred-parked", "awaiting-human"]);
  const ranked = [...results].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const primary = ranked[0];
  if (primary) {
    const counts = !NON_STUCK.has(primary.name) && d.derivedStatus !== "deferred";
    // honor the staleness floor: only count as stuck when the anomaly is at least staleFloorMin old.
    const oldEnough = ctx.staleFloorMin == null || primary.sinceMinutes == null || primary.sinceMinutes >= ctx.staleFloorMin;
    d.stuck = {
      isStuck: counts && oldEnough,
      severity: primary.severity,
      detector: primary.name,
      reason: primary.reason,
      sinceMinutes: primary.sinceMinutes,
      suggestedAction: primary.suggestedAction,
    };
  }
  return d;
}

// ── Public entry point ───────────────────────────────────────────────────────

/** The (effectively single-tenant) build-console workspace, mirroring brain-roadmap's resolver: ride the
 *  latest agent_jobs row, else the oldest workspace. */
async function resolveWorkspaceId(): Promise<string | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: job } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromJob = (job as { workspace_id?: string } | null)?.workspace_id;
  if (fromJob) return fromJob;
  const { data: ws } = await admin
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (ws as { id?: string } | null)?.id ?? null;
}

/**
 * Diagnose the whole spec pipeline. Read-only. Composes getRoadmap (derived status), the agent-jobs
 * readers, the spec-test + security rollups, and the lifecycle derivation; then runs every classifier.
 */
export async function diagnosePipeline(opts: DiagnoseOptions = {}): Promise<PipelineDiagnosis> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const workspaceId = opts.workspaceId ?? (await resolveWorkspaceId());
  if (!workspaceId) throw new Error("pipeline-doctor: could not resolve a workspace");
  const now = Date.now();

  // Batched canonical reads — the same sources the board + fold gate read, so the doctor can't drift.
  const [roadmap, latestJobsBySlug, runs, liveSpecTestSlugs, securityBySlug, humanResolutions] = await Promise.all([
    getRoadmap(workspaceId),
    getLatestJobsBySlug(workspaceId),
    getLatestSpecTestRuns(workspaceId),
    getLiveSpecTestSlugs(workspaceId),
    getSecurityStateBySlug(admin, workspaceId),
    getHumanCheckResolutions(workspaceId),
  ]);

  let cards = roadmap.specs;
  if (opts.slug) cards = cards.filter((c) => c.slug === opts.slug);
  const slugSet = new Set(cards.map((c) => c.slug));

  // ONE targeted raw `specs` read — the stored-status-override check needs the raw column (the canonical
  // readers deliberately never surface it). Also pulls milestone_id (goal binding) + deferred.
  const { data: rawSpecsData } = await admin
    .from("specs")
    .select("slug, status, milestone_id, deferred")
    .eq("workspace_id", workspaceId);
  const rawBySlug = new Map<string, RawSpecRow>();
  for (const r of (rawSpecsData ?? []) as RawSpecRow[]) rawBySlug.set(r.slug, r);

  // Goal-binding map: milestone_id → goal slug (one batched join, no per-spec reads).
  const goalSlugByMilestone = new Map<string, string>();
  const milestoneIds = [...rawBySlug.values()].map((r) => r.milestone_id).filter((x): x is string => !!x);
  if (milestoneIds.length) {
    const { data: ms } = await admin.from("goal_milestones").select("id, goal_id").in("id", [...new Set(milestoneIds)]);
    const goalIdByMilestone = new Map<string, string>();
    const goalIds: string[] = [];
    for (const m of (ms ?? []) as { id: string; goal_id: string }[]) {
      goalIdByMilestone.set(m.id, m.goal_id);
      goalIds.push(m.goal_id);
    }
    if (goalIds.length) {
      const { data: gs } = await admin.from("goals").select("id, slug").in("id", [...new Set(goalIds)]);
      const slugByGoalId = new Map<string, string>();
      for (const g of (gs ?? []) as { id: string; slug: string }[]) slugByGoalId.set(g.id, g.slug);
      for (const [mid, gid] of goalIdByMilestone) {
        const gslug = slugByGoalId.get(gid);
        if (gslug) goalSlugByMilestone.set(mid, gslug);
      }
    }
  }

  // Per-kind latest job: getLatestJobsBySlug gives only ONE latest non-meta job per slug. The doctor needs
  // the latest per (slug, kind), so pull the relevant kinds in one batched read, newest-first.
  const jobsBySlug = new Map<string, AgentJob[]>();
  if (slugSet.size) {
    const { data: jobRows } = await admin
      .from("agent_jobs")
      .select("*")
      .eq("workspace_id", workspaceId)
      .in("kind", RELEVANT_JOB_KINDS)
      .in("spec_slug", [...slugSet])
      .order("created_at", { ascending: false })
      .limit(4000);
    for (const j of (jobRows ?? []) as AgentJob[]) {
      const arr = jobsBySlug.get(j.spec_slug) ?? [];
      arr.push(j);
      jobsBySlug.set(j.spec_slug, arr);
    }
  }
  // Fall back to the canonical latest-non-meta job when the per-kind pull missed a slug (defensive).
  for (const slug of slugSet) {
    if (!jobsBySlug.has(slug) && latestJobsBySlug[slug]) jobsBySlug.set(slug, [latestJobsBySlug[slug]]);
  }

  // Defer-audit reasons for any deferred spec (one batched read over spec_status_history, best-effort).
  const deferAuditBySlug = new Map<string, string>();
  const deferredSlugs = cards.filter((c) => c.status === "deferred").map((c) => c.slug);
  if (deferredSlugs.length) {
    const { data: hist } = await admin
      .from("spec_status_history")
      .select("spec_slug, actor, reason, field, to_value, at")
      .eq("workspace_id", workspaceId)
      .in("spec_slug", deferredSlugs)
      .order("at", { ascending: false })
      .limit(500);
    for (const h of (hist ?? []) as { spec_slug: string; actor: string | null; reason: string | null; field: string | null; to_value: string | null; at: string }[]) {
      if (deferAuditBySlug.has(h.spec_slug)) continue; // latest line per slug wins
      deferAuditBySlug.set(h.spec_slug, `Deferred by ${h.actor ?? "?"}${h.reason ? ` — ${h.reason}` : ""}.`);
    }
  }

  // Build-pool occupancy (active build jobs across the workspace) for the not-claimed call.
  const { data: activeBuildRows } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "build")
    .in("status", ACTIVE_STATUSES as unknown as string[]);
  const activeBuilds = (activeBuildRows ?? []).length;

  const ctx: DoctorContext = {
    workspaceId,
    now,
    activeBuilds,
    staleFloorMin: opts.sinceHours != null ? opts.sinceHours * 60 : null,
  };

  const diagnoses = cards.map((card) => {
    const raw = rawBySlug.get(card.slug);
    const goalSlug = raw?.milestone_id ? goalSlugByMilestone.get(raw.milestone_id) ?? null : null;
    return assembleSpec(
      card,
      raw,
      jobsBySlug.get(card.slug) ?? [],
      runs[card.slug] ?? null,
      liveSpecTestSlugs,
      securityBySlug[card.slug],
      humanResolutions,
      goalSlug,
      deferAuditBySlug.get(card.slug),
      ctx,
    );
  });

  const storedStatusViolations = diagnoses.filter((d) => d.detectors.some((r) => r.name === "stored-status-override-violation"));
  const stuck = diagnoses.filter((d) => d.stuck.isStuck);
  const awaitingHuman = diagnoses.filter((d) => d.detectors.some((r) => r.name === "awaiting-human"));

  const bySeverity: Record<Severity, number> = { none: 0, info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const d of stuck) bySeverity[d.stuck.severity]++;

  // Stuck-first ordering: stuck (by severity desc, then age desc), then the rest.
  const sorted = [...diagnoses].sort((a, b) => {
    if (a.stuck.isStuck !== b.stuck.isStuck) return a.stuck.isStuck ? -1 : 1;
    const sev = SEVERITY_RANK[b.stuck.severity] - SEVERITY_RANK[a.stuck.severity];
    if (sev) return sev;
    return (b.stuck.sinceMinutes ?? 0) - (a.stuck.sinceMinutes ?? 0);
  });

  // Default (compact) view: stuck specs + anything actionable-by-human (awaiting-human). Deferred + purely
  // informational specs are shown only under --all / --slug. Stored-status violations always render in their
  // own loud section above regardless.
  const specsOut =
    opts.slug || opts.includeHealthy
      ? sorted
      : sorted.filter((d) => d.stuck.isStuck || d.detectors.some((r) => r.name === "awaiting-human"));

  return {
    workspaceId,
    generatedAt: new Date(now).toISOString(),
    totals: {
      total: diagnoses.length,
      stuck: stuck.length,
      healthy: diagnoses.length - stuck.length,
      awaitingHuman: awaitingHuman.length,
      bySeverity,
    },
    storedStatusViolations,
    lanes: { buildPoolSize: BUILD_POOL_SIZE, activeBuilds },
    specs: specsOut,
  };
}

/**
 * SLUG-SCOPED single-spec diagnosis — the FAST path for the investigation SDK ([[spec-investigation]] /
 * Mario). Reuses the exact same `assembleSpec` + classifier registry as {@link diagnosePipeline} (one
 * classification source, no drift), but every read is scoped to this one slug instead of the workspace:
 * the board path pulls ALL jobs / ALL spec-test runs / ALL security state / ALL human resolutions and
 * filters down; a single-spec investigate must not (Mario runs this per stall). Returns null when the
 * slug has no boardable spec row. `activeBuilds` (the lane-occupancy context the not-claimed detector
 * reads) is a COUNT-only query — no rows transferred.
 */
export async function diagnoseSpec(workspaceId: string, slug: string): Promise<SpecDiagnosis | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const now = Date.now();

  // The canonical card (RPC-backed get_spec_with_phases + one light all-spec-rows read for blocker
  // resolution — inherent, since blocked_by clearance needs sibling states; far lighter than the board fan-out).
  const got = await getSpecCard(slug, workspaceId);
  if (!got) return null;
  const card = got.card;

  // ONE slug-scoped raw row (the override column + goal binding + deferred).
  const { data: rawRow } = await admin
    .from("specs")
    .select("slug, status, milestone_id, deferred")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  const raw = (rawRow ?? undefined) as RawSpecRow | undefined;

  // Slug-scoped: the relevant-kind jobs (newest first), the latest spec-test run, live-spec-test flag,
  // security rollup, and the active-build COUNT — all in parallel, none workspace-wide.
  const [jobsRes, runRes, liveActive, security, buildCount] = await Promise.all([
    admin.from("agent_jobs").select("*").eq("workspace_id", workspaceId).in("kind", RELEVANT_JOB_KINDS as string[]).eq("spec_slug", slug).order("created_at", { ascending: false }).limit(200),
    admin.from("spec_test_runs").select("*").eq("workspace_id", workspaceId).eq("spec_slug", slug).order("run_at", { ascending: false }).limit(1),
    hasActiveSpecTestJob(workspaceId, slug),
    getSecurityStateForSlug(admin, workspaceId, slug),
    admin.from("agent_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("kind", "build").in("status", ACTIVE_STATUSES as unknown as string[]),
  ]);

  const jobs = (jobsRes.data ?? []) as AgentJob[];
  const runRows = (runRes.data ?? []) as Record<string, unknown>[];
  const run = runRows.length ? normalizeRun(runRows[0]) : null;
  const liveSpecTestSlugs = liveActive ? new Set<string>([slug]) : new Set<string>();
  // Single-spec fast path skips the workspace-wide human-resolution map (it only feeds the human-QA
  // detail node, never the primary stuck verdict) — an empty map is a safe, correctness-equivalent input.
  const humanResolutions = new Map<string, HumanCheckRow>();
  const goalSlug = raw?.milestone_id ? await resolveGoalSlugForSpec(workspaceId, slug) : null;

  let deferAudit: string | undefined;
  if (card.status === "deferred") {
    const { data: hist } = await admin
      .from("spec_status_history")
      .select("actor, reason")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .order("at", { ascending: false })
      .limit(1);
    const h = ((hist ?? [])[0] ?? null) as { actor: string | null; reason: string | null } | null;
    if (h) deferAudit = `Deferred by ${h.actor ?? "?"}${h.reason ? ` — ${h.reason}` : ""}.`;
  }

  const ctx: DoctorContext = { workspaceId, now, activeBuilds: buildCount.count ?? 0, staleFloorMin: null };
  return assembleSpec(card, raw, jobs, run, liveSpecTestSlugs, security, humanResolutions, goalSlug, deferAudit, ctx);
}

/** Build/plan pool occupancy — the lane context for the "stuck vs just queued" call, as a COUNT-only
 *  read (no rows transferred). Exposed so single-spec callers get lane context without a full diagnosis. */
export async function getLaneOccupancy(workspaceId: string): Promise<{ buildPoolSize: number; activeBuilds: number }> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { count } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("kind", "build")
    .in("status", ACTIVE_STATUSES as unknown as string[]);
  return { buildPoolSize: BUILD_POOL_SIZE, activeBuilds: count ?? 0 };
}
