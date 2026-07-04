/**
 * deploy-guardian — Reva, the Deploy Guardian (docs/brain/specs/deploy-health-rollback-guardian.md).
 *
 * The supervisor on the auto-merge proxy. Auto-merge ([[github-pr-resolve]] `autoMergeReadyPrs`)
 * optimizes "ship the fix"; its degenerate state is shipping a fix that breaks something else and
 * leaving it live. This guardian watches each auto-merged claude/<slug> deploy over a bounded canary
 * window and stamps a verdict — restore-known-good FAST on a clear deploy-correlated regression (Phase
 * 2), escalate anything ambiguous rather than guess.
 *
 * PHASE 1: WATCH.
 *  - `openDeployWatch` is called from the auto-merge path the moment a build branch squash-merges. It
 *    snapshots the PRE-deploy error/loop baseline and inserts a `pending` row in `deploy_watches` with
 *    a canary window (deployed_at → deployed_at + CANARY_WINDOW_MS).
 *  - `evaluateDueDeployWatches` (driven every minute by [[../inngest/deploy-guardian-cron]]) evaluates
 *    each watch whose window has elapsed: it samples NEW error_events signatures + NEW open loop_alerts
 *    + the live Control-Tower snapshot, attributing only signals that FIRST appear AFTER the deploy
 *    timestamp (the correlation gate, mirroring agent-outage-resilience's outage-correlation tagging),
 *    then stamps healthy | regressed | unsure.
 *
 * PHASE 2 (this file): ACT on the verdict — the supervisor's conservative move.
 *  - `regressed` → `revertDeployMerge` restores known-good (a `git revert` of the offending squash via the
 *    GitHub git-data API: the exact prior tree when nothing landed since, else a true single-commit revert
 *    of only this deploy's files — escalating instead of clobbering if a later commit touched them) + an
 *    `escalateDiagnosisToCeo` carrying what regressed + the revert (the Phase-3 escalation plumbing).
 *    A revert is itself reversible (revert-of-a-revert re-lands the fix), so this is inside the leash.
 *  - Loop-guard: a slug that regresses again after `DEPLOY_GUARDIAN_LOOP_GUARD_MAX` prior auto-rollbacks is
 *    a rollback-then-reland loop (a deeper issue) → STOP auto-reverting + escalate (mirrors the platform
 *    director's `PLATFORM_DIRECTOR_LOOP_GUARD_MAX`).
 *  - `unsure` (and a regression the guardian can't cleanly revert) → escalate, move nothing.
 *  - Each acted watch writes a `deploy_rolled_back` / `deploy_regressed` / `deploy_unsure` director_activity
 *    row (the board-watch + KPI scorecard surface).
 *
 * Reuses Tao's Control-Tower signals + the error feed — no new monitoring substrate. Best-effort +
 * never throws on the open path (an audit/watch write that crashes the merge it records is worse than
 * the gap — mirrors `recordError` / `recordDirectorActivity`). The revert itself never throws — it
 * returns a structured result, and a failed/conflicting revert escalates rather than guesses.
 *
 * See [[../tables/deploy_watches]] · [[../tables/error_events]] · [[../tables/loop_alerts]] ·
 * [[control-tower]] · [[director-activity]] · [[github-pr-resolve]] · [[../goals/devops-director]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { buildControlTowerSnapshot } from "@/lib/control-tower/monitor";
import { isAuditSkippedKpiDriftLoop } from "@/lib/agents/platform-scorecard";
import { recordDirectorActivity } from "@/lib/director-activity";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { notifyOpsAlert } from "@/lib/notify-ops-alert";

type Admin = ReturnType<typeof createAdminClient>;

/** The Platform/DevOps Director supervises the Deploy Guardian — its director_activity rows carry this. */
const GUARDIAN_FUNCTION = "platform";
/**
 * The persona key that stamps the activity row's `metadata.actor` — Reva (the Deploy Guardian). The
 * supervising director_function is still `platform`, but the actor tag lets the worker profile + the
 * Ada feed show the work as REVA's (not a bare "platform" function row). Mirrors the spec-drift
 * reconciler's `actor: "reconciler:spec-drift"` tagging — same activity ledger, named author.
 */
const GUARDIAN_ACTOR = "deploy-guardian";

/** Bounded canary window: how long after a deploy we watch before stamping a verdict (10–15 min band). */
export const CANARY_WINDOW_MS = Number(process.env.DEPLOY_GUARDIAN_CANARY_WINDOW_MS || 12 * 60 * 1000);

/**
 * "A clear spike of NEW errors" (the `regressed` bar). With the strong correlation gate already applied
 * (a signature that FIRST appears AFTER the deploy + is NOT outage-correlated), either of:
 *  - ≥ MIN_SIGNATURES distinct new deploy-correlated signatures, OR
 *  - any single new signature recurring ≥ MIN_COUNT times within the window
 * is a clear spike → `regressed`. Exactly one new low-count signature is ambiguous (could be foreign
 * transient noise) → `unsure` (escalate, never auto-act — Phase 2). Env-overridable.
 */
export const DEPLOY_REGRESSION_MIN_SIGNATURES = Number(process.env.DEPLOY_GUARDIAN_MIN_SIGNATURES || 2);
export const DEPLOY_REGRESSION_MIN_COUNT = Number(process.env.DEPLOY_GUARDIAN_MIN_COUNT || 3);

/**
 * Blast-radius gate (the second correlation filter, alongside `outage_correlated`): an error source / shape
 * a Vercel CODE deploy has NO causal path to is NOT this deploy's regression — it's a foreign signal that
 * merely shares the canary window. Excluding these is what `outage_correlated` already does for outages;
 * this generalizes it to two classes the canary kept mis-attributing (build-card-lifecycle-timeline Phase 3
 * incident: a `getAutoFoldEligibleSlugs` fold-gate diff was auto-reverted twice — once on a 1-second burst of
 * `supabase-logs` gateway 502s, once on a recurring Appstle `UserGeneratedError` billing condition — neither
 * touchable by the merged code, both `newRedLoops:[]`):
 *
 *  - `supabase-logs` — the Supabase DB-log poller's edge-API 5xx / `context canceled` / auth-gateway errors.
 *    These are the Postgres/PostgREST/GoTrue gateway's OWN infra blips (platform-wide, hit unrelated routes
 *    like `/auth/v1/user`, `/rest/v1/specs`). A deploy ships Vercel functions; it cannot make Supabase's
 *    gateway return 502. Same exclusion class as an outage — still surfaced on the error feed, never an
 *    auto-revert trigger. (Override: `DEPLOY_GUARDIAN_INCLUDE_INFRA_SOURCES=1` to re-arm them.)
 *  - `UserGeneratedError:` — Appstle / business-state errors that fire on the customer's billing cadence, not
 *    the code path (e.g. "Subscription contract cannot be updated if there is a current/upcoming billing
 *    cycle edit"). A user/business-state condition, not a code fault — surfaced, never auto-reverted.
 */
const DEPLOY_REGRESSION_EXCLUDED_SOURCES: ReadonlySet<string> =
  process.env.DEPLOY_GUARDIAN_INCLUDE_INFRA_SOURCES === "1" ? new Set() : new Set(["supabase-logs"]);

/** A `vercel`/`inngest` error whose TITLE marks it a user/business-state condition, not a code fault. */
function isUserGeneratedError(title: string | null): boolean {
  return /UserGeneratedError\b/i.test(title || "");
}

/** Is this new-error signature a foreign infra / user-state signal a code deploy can't have caused? */
export function isExcludedFromDeployRegression(r: { source: string; title: string | null }): boolean {
  return DEPLOY_REGRESSION_EXCLUDED_SOURCES.has(r.source) || isUserGeneratedError(r.title);
}

/**
 * Extract the cadence off a `kpi_drift:<metric>:<cadence>` loop_id (or null when it's not a kpi_drift loop).
 * Used by the monthly-cadence exclusion below.
 */
function kpiDriftCadence(loopId: string): "daily" | "weekly" | "monthly" | null {
  const m = /^kpi_drift:.+:(daily|weekly|monthly)$/.exec(loopId || "");
  return (m ? (m[1] as "daily" | "weekly" | "monthly") : null);
}

/**
 * Is this loop a MONTHLY-cadence `kpi_drift`? Monthly kpi_drift metrics are trailing-30-day AGGREGATES
 * (`human_touch_per_build`, `deploy_reliability`, …) — a canary window is minutes to hours, so a single
 * deploy CANNOT causally shift a 30-day trailing ratio inside its window. Attributing a monthly kpi_drift
 * red loop to one deploy is a category error at the timescale level.
 *
 * False-positive class fixed: Reva auto-rolled back `blog-pixel-tracking` on a single
 * `kpi_drift:human_touch_per_build:monthly` red loop — a BUILD-PIPELINE autonomy KPI a storefront pixel
 * cannot causally affect, and the alert self-resolved 50 min later. Monthly kpi_drift is now excluded
 * from `newRedLoops` regardless of the metric's registry classification.
 */
export function isMonthlyKpiDriftLoop(loopId: string): boolean {
  return kpiDriftCadence(loopId) === "monthly";
}

/**
 * Human-readable reason a newly-opened `loop_alerts` row is EXCLUDED from `newRedLoops` (or null when it's a
 * signal we DO count). Surfaced on `deploy_watches.findings.excludedRedLoops` so the rollback decision is
 * auditable — the supervisor can see which signals were considered and which were dropped, and why.
 */
export function reasonExcludedFromDeployRegressionLoop(loopId: string): string | null {
  const cadence = kpiDriftCadence(loopId);
  // WEEKLY + MONTHLY kpi_drift are aggregates over a 7-day / 30-day trailing window; a canary window is
  // minutes-to-hours, so a single deploy CANNOT causally shift either inside it — the same timescale
  // category error `isMonthlyKpiDriftLoop` already guards for monthly. We exclude BOTH by CADENCE,
  // independent of any registry flag. This closes the flag-removal trap that reverted 3 good specs on
  // 2026-07-03: `director-kpi-sdk` (correctly) dropped `specs_per_week`'s `liveSpecSetDependent` flag, which
  // was the SOLE thing excluding `kpi_drift:specs_per_week:weekly` from rollback — so removing the flag
  // re-armed Reva to revert that very fix (and two concurrent deploys) on a weekly aggregate no deploy can
  // move. Cadence-based exclusion no longer depends on the fragile flag. (Same class as the prior
  // noop-pipeline-test-6 weekly false-revert.) Only DAILY / windowed / error-rate loops stay attributable.
  if (cadence === "monthly" || cadence === "weekly") {
    return `${cadence}-cadence kpi_drift — trailing ${cadence === "weekly" ? "7" : "30"}-day aggregate, not deploy-attributable inside a canary window`;
  }
  if (isAuditSkippedKpiDriftLoop(loopId)) {
    return "audit-skipped kpi_drift metric (liveSpecSetDependent/currentState) — PM volume / membership delta, not the deployed code";
  }
  return null;
}

/**
 * Is this newly-opened `loop_alerts` row a signal a Vercel CODE deploy has NO causal path to — the
 * loop-side twin of {@link isExcludedFromDeployRegression}? Three classes are excluded from
 * `newRedLoops`:
 *
 *  - `kpi_drift:<metric>:<cadence>` loops for an AUDIT-SKIPPED metric — the `liveSpecSetDependent`
 *    weekly-aggregate / live-spec-set meta-metrics (today: `regression_coverage_pct`; `specs_per_week`
 *    was in this class until director-kpi-sdk Phase 1 repointed its slug→owner map at the folded-
 *    inclusive [[director-kpis]] SDK, which stabilized its snapshot/audit population and removed the
 *    flag) and the `currentState` point-reads (kpi-audit-skip-live-spec-set-dependent-metrics, #848).
 *    These reflect PM VOLUME / a moving-population membership delta (how many specs shipped this
 *    week + their regression coverage), NOT the deployed code — a no-op spec's deploy cannot move
 *    them. Reusing the SAME `liveSpecSetDependent`/`currentState` registry flags #848 introduced
 *    ([[platform-scorecard]] `isAuditSkippedKpiDriftLoop` — single source of truth) keeps the audit
 *    skip and the deploy-attribution gate from drifting apart.
 *  - Any `kpi_drift:<metric>:monthly` loop (regardless of the metric's registry flags) — the cadence
 *    itself makes the signal too laggy to attribute to one deploy inside a canary window
 *    ({@link isMonthlyKpiDriftLoop}). This is the blog-pixel-tracking false-revert class.
 *
 * Real per-deploy loops — a genuine DAILY windowed-aggregate kpi_drift, an error-rate loop, a
 * test/regression loop — are NOT excluded and still trip `regressed`.
 *
 * Prior false-positive class fixed: Reva auto-reverted `noop-pipeline-test-6` (a no-op spec) because the
 * two weekly-aggregate kpi_drift loops (`specs_per_week`, `regression_coverage_pct`) flipped red in its
 * canary window from a high-volume PM night — drift that had nothing to do with the deploy.
 */
export function isExcludedFromDeployRegressionLoop(r: { loop_id: string }): boolean {
  return reasonExcludedFromDeployRegressionLoop(r.loop_id) !== null;
}

/** Cap the watches evaluated per cron tick so a backlog can't run the tick unbounded. */
const EVAL_BATCH_CAP = 25;

/**
 * Loop-guard (Phase 2): a slug that regresses AGAIN after this many prior auto-rollbacks is stuck in a
 * rollback-then-reland loop (a deeper issue, not a flaky deploy) → STOP auto-reverting + escalate the
 * deeper issue to the CEO. Mirrors `PLATFORM_DIRECTOR_LOOP_GUARD_MAX`. Env-overridable.
 */
export const DEPLOY_GUARDIAN_LOOP_GUARD_MAX = Number(process.env.DEPLOY_GUARDIAN_LOOP_GUARD_MAX || 2);
/** The window the loop-guard counts prior auto-rollbacks of the same slug over (mirrors the regression agent). */
const RELAND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * The autorevert **kill-switch** ([[../specs/reva-box-session-causal-rollback]] Phase 4). Two values:
 *  - `'box'` (default) — the full box-session path: the cron enqueues a Reva review job on a non-healthy
 *    verdict; `applyBoxDeployReview` applies Reva's typed verdict, `revertDeployMerge` on 'revert'.
 *  - `'off'` — SURFACE-ONLY. The cron still enqueues the review + Reva still runs (so the audit surface
 *    on `deploy_watches.findings.reva_review` is preserved); `applyBoxDeployReview` still stamps + writes
 *    activity — but a decision='revert' is DEGRADED to 'escalate' (never calls `revertDeployMerge`). This
 *    is the "emergency stop" the founder can flip when Reva is producing false positives or during a
 *    controlled experiment: the guardian keeps its eyes open but its hands tied.
 * Read by `applyBoxDeployReview` (the mutator) — not by the cron enqueue path, so surface state stays
 * populated regardless of the mode.
 */
export type DeployGuardianAutorevertMode = "box" | "off";
export const DEPLOY_GUARDIAN_AUTOREVERT_MODE: DeployGuardianAutorevertMode =
  process.env.DEPLOY_GUARDIAN_AUTOREVERT_MODE === "off" ? "off" : "box";
/** Is autorevert currently enabled? Convenience for the mutator's decision-branch gate. */
export function isAutoRevertEnabled(): boolean {
  return DEPLOY_GUARDIAN_AUTOREVERT_MODE === "box";
}

/**
 * Optional narrow fast-path ([[../specs/reva-box-session-causal-rollback]] Phase 4) — a deterministic
 * SAME-SURFACE HIGH-COUNT match (a new error whose `sample.path` matches a changed file's route AND
 * `count ≥ DEPLOY_REGRESSION_MIN_COUNT`) may revert immediately, skipping Reva's session. Kept **OFF
 * by default** behind this env until we validate the false-positive rate against the 2026-07-04
 * fixtures — a false fast-path revert is exactly what the whole causal-review effort exists to prevent.
 * When `off`, the fast-path never fires; the enqueue path is unchanged.
 */
export const DEPLOY_GUARDIAN_SAME_SURFACE_FASTPATH: boolean =
  process.env.DEPLOY_GUARDIAN_SAME_SURFACE_FASTPATH === "1";

// ── GitHub git-data API (the rollback hand) ──────────────────────────────────
// Reva restores known-good via the SAME GitHub REST token/repo the auto-merge gate ([[github-pr-resolve]])
// already uses — no new credential, no box round-trip (the cron runs in the Vercel/Inngest runtime).
const GH_REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
const MAIN_BRANCH = process.env.AGENT_TODO_MAIN_BRANCH || "main";
function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}
async function gh(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/**
 * The `deploy_watches.verdict` values. `healthy | regressed | unsure` are the findings-derived
 * verdicts `verdictFor` returns; `in_review` is a NEW lifecycle state stamped by the cron on a
 * non-healthy verdict when it enqueues a Reva deploy-review box-session job (reva-box-session-causal-
 * rollback Phase 1) — the box session decides revert|keep|escalate and Phase 3's applyBoxDeployReview
 * stamps the final verdict (healthy on keep, regressed on revert, unsure on escalate).
 */
export type DeployVerdict = "healthy" | "regressed" | "unsure" | "in_review";

export interface DeployWatch {
  id: string;
  workspace_id: string;
  slug: string;
  branch: string;
  pr_number: number | null;
  merge_sha: string | null;
  deployed_at: string;
  window_ends_at: string;
  baseline: { errorSignatures?: string[]; openLoopAlertIds?: string[] } | null;
  verdict: "pending" | DeployVerdict;
  evaluated_at: string | null;
  findings: Record<string, unknown> | null;
  created_at: string;
  /** spec-goal-branch-pm-flow M5: true ⇒ this watch guards an ATOMIC goal→main promotion (a goal/{slug}
   *  deploy carrying many specs). A regression on an atomic watch ESCALATES, never auto-reverts (reverting a
   *  whole goal is far costlier than a per-phase revert). Optional/`false` on a pre-migration row read. */
  is_atomic?: boolean;
}

/** Derive the spec slug from a `claude/<slug>` build branch. */
export function slugFromClaudeBranch(branch: string): string {
  return branch.startsWith("claude/") ? branch.slice("claude/".length) : branch;
}

/** Snapshot the PRE-deploy baseline: existing error signatures + already-open loop_alert ids. */
async function captureBaseline(
  admin: Admin,
  deployedAtIso: string,
): Promise<{ errorSignatures: string[]; openLoopAlertIds: string[] }> {
  const [errs, alerts] = await Promise.all([
    admin.from("error_events").select("signature").lte("first_seen_at", deployedAtIso),
    admin.from("loop_alerts").select("loop_id").eq("status", "open"),
  ]);
  const errorSignatures = Array.from(
    new Set(((errs.data as { signature: string }[] | null) || []).map((r) => r.signature).filter(Boolean)),
  );
  const openLoopAlertIds = Array.from(
    new Set(((alerts.data as { loop_id: string }[] | null) || []).map((r) => r.loop_id).filter(Boolean)),
  );
  return { errorSignatures, openLoopAlertIds };
}

/**
 * Open a deploy-watch over a just-merged deploy. Two callers:
 *
 *  - PER-SPEC (the original): a `claude/<slug>` build branch squash-merged to main by Gate A
 *    (`autoMergeReadyPrs`). The owning workspace + spec slug are resolved from the branch's build job; a
 *    regression auto-reverts (the small per-phase diff is cheap + safe to roll back).
 *
 *  - ATOMIC (spec-goal-branch-pm-flow M5): a `goal/<slug>` branch promoted to main in ONE atomic merge by
 *    `promoteCompleteGoalsToMain` → `mergeGoalBranchIntoMain`, carrying MANY specs' worth of changes in a
 *    SINGLE Vercel deploy — the highest-blast-radius deploy in the system. The branch is `goal/*` (not
 *    `claude/*`) and there's NO single `kind='build'` job keyed to it, so the caller passes `workspaceId`,
 *    `slug` (the goal slug), and `isAtomic: true` explicitly. An atomic watch is marked `is_atomic` so the
 *    verdict path ESCALATES a regression instead of auto-reverting — rolling back a whole tested goal on a
 *    hair-trigger bar (tuned for tiny per-phase diffs) would false-revert many specs' work; a human decides.
 *
 * Snapshots the pre-deploy baseline + inserts a `pending` watch over the canary window. Idempotent on
 * `merge_sha` (the partial unique index). Best-effort + NEVER throws — a watch that crashes the merge it
 * guards is worse than the gap it closes. Returns the watch id (or null if it no-op'd: no build job for a
 * per-spec branch, already opened, table absent).
 *
 * `is_atomic` tolerance: the column is added by 20260730120000_deploy_watches_is_atomic.sql; until that
 * migration lands, an insert carrying `is_atomic` would error on the unknown column — so we retry WITHOUT it
 * (the atomic-escalation bias degrades to the existing path, which is conservative anyway).
 */
export async function openDeployWatch(args: {
  admin: Admin;
  branch: string;
  prNumber?: number | null;
  mergeSha?: string | null;
  /** override the deploy timestamp (defaults to now — the merge just happened). */
  deployedAt?: string;
  /** spec-goal-branch-pm-flow M5: the atomic-goal path supplies these directly (a goal/* branch has no
   *  `kind='build'` job to resolve them from). When set, the build-job lookup is skipped. */
  workspaceId?: string;
  slug?: string;
  /** spec-goal-branch-pm-flow M5: mark the watch as guarding an atomic goal→main promotion (bias to escalate,
   *  never auto-revert a whole goal). */
  isAtomic?: boolean;
}): Promise<string | null> {
  const { admin, branch } = args;
  try {
    let workspaceId = args.workspaceId ?? null;
    let slug = args.slug ?? null;

    if (!workspaceId || !slug) {
      // PER-SPEC path: resolve the owning workspace + spec slug from the branch's most recent build job
      // (mirrors handleAutoMergedBuildBranch). Requires a `claude/*` build branch; no build job ⇒ not the
      // director's auto-fix path ⇒ don't watch.
      if (!branch || !branch.startsWith("claude/")) return null;
      const { data: jobRow } = await admin
        .from("agent_jobs")
        .select("workspace_id, spec_slug")
        .eq("spec_branch", branch)
        .eq("kind", "build")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const job = jobRow as { workspace_id: string; spec_slug: string } | null;
      if (!job?.workspace_id) return null;
      workspaceId = job.workspace_id;
      slug = job.spec_slug || slugFromClaudeBranch(branch);
    }

    const deployedAt = args.deployedAt || new Date().toISOString();
    const windowEndsAt = new Date(new Date(deployedAt).getTime() + CANARY_WINDOW_MS).toISOString();
    const baseline = await captureBaseline(admin, deployedAt);

    const baseRow: Record<string, unknown> = {
      workspace_id: workspaceId,
      slug,
      branch,
      pr_number: args.prNumber ?? null,
      merge_sha: args.mergeSha ?? null,
      deployed_at: deployedAt,
      window_ends_at: windowEndsAt,
      baseline,
      verdict: "pending",
    };

    let insert = await admin
      .from("deploy_watches")
      .insert({ ...baseRow, is_atomic: !!args.isAtomic })
      .select("id")
      .single();
    // Tolerate the pre-migration schema: a 42703 (undefined column) means is_atomic isn't deployed yet —
    // retry without it (the atomic-escalation bias degrades to the existing conservative path).
    if (insert.error && (insert.error.code === "42703" || /is_atomic/.test(insert.error.message || ""))) {
      insert = await admin.from("deploy_watches").insert(baseRow).select("id").single();
    }
    const { data, error } = insert;

    if (error) {
      // 23505 = the partial unique index already opened a watch for this merge SHA — fine, not an error.
      if (error.code === "23505") return null;
      console.warn(`[deploy-guardian] openDeployWatch insert failed (${branch}):`, error.message);
      return null;
    }
    console.log(`[deploy-guardian] opened ${args.isAtomic ? "ATOMIC " : ""}deploy-watch for ${branch} (slug=${slug}) → window ${Math.round(CANARY_WINDOW_MS / 60000)}m`);
    return (data as { id: string }).id;
  } catch (e) {
    console.warn("[deploy-guardian] openDeployWatch threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

export interface DeployWatchFindings {
  /** distinct error signatures that FIRST appeared after the deploy (the correlation gate) + their counts. */
  newErrorSignatures: Array<{ signature: string; source: string; title: string | null; count: number }>;
  /** loop_alerts that opened red AFTER the deploy (not pre-existing). */
  newRedLoops: Array<{ loop_id: string; reason: string; detail: string }>;
  /**
   * loop_alerts that opened in the canary window but were EXCLUDED as not causally deploy-scoped —
   * monthly-cadence kpi_drift (30-day trailing aggregate) and audit-skipped kpi_drift metrics
   * (liveSpecSetDependent/currentState). Surfaced so the rollback decision is auditable: the supervisor
   * can see which signals were considered and which were dropped, and why (spec Phase 3 — the
   * blog-pixel-tracking spurious-rollback root fix).
   */
  excludedRedLoops: Array<{ loop_id: string; excluded_reason: string }>;
  /** red loop count from the live Control-Tower snapshot (a cross-check; null if the snapshot failed). */
  redLoopCount: number | null;
  controlTowerOk: boolean;
}

/** Sample the NEW (deploy-correlated) signals for a watch, then derive the verdict. */
export async function gatherDeployFindings(admin: Admin, watch: DeployWatch): Promise<DeployWatchFindings> {
  const baselineSignatures = new Set(watch.baseline?.errorSignatures || []);
  const baselineLoopIds = new Set(watch.baseline?.openLoopAlertIds || []);
  const deployedAt = watch.deployed_at;

  // NEW error signatures: first seen WITHIN the canary window [deployed_at, window_ends_at], NOT
  // outage-correlated (those are outage symptoms, not this deploy's regression — agent-outage-resilience),
  // NOT a foreign infra/user-state signal a code deploy can't have caused (DEPLOY_REGRESSION_EXCLUDED_SOURCES
  // / UserGeneratedError — the second blast-radius filter), and NOT in the pre-deploy baseline. Bounding the
  // upper end to window_ends_at keeps attribution to THIS deploy's window even if the evaluator cron runs late
  // (a later error belongs to a later deploy).
  const { data: errRows } = await admin
    .from("error_events")
    .select("signature, source, title, count, first_seen_at, outage_correlated")
    .gte("first_seen_at", deployedAt)
    .lte("first_seen_at", watch.window_ends_at)
    .eq("outage_correlated", false);
  const newErrorSignatures = ((errRows as Array<{ signature: string; source: string; title: string | null; count: number }> | null) || [])
    .filter((r) => r.signature && !baselineSignatures.has(r.signature) && !isExcludedFromDeployRegression(r))
    .map((r) => ({ signature: r.signature, source: r.source, title: r.title, count: r.count ?? 1 }));

  // NEW red loops: an alert that OPENED after the deploy + isn't one that was already open at deploy time,
  // AND is a signal a code deploy can actually have caused. A `kpi_drift` loop for an audit-skipped metric
  // (the `liveSpecSetDependent` weekly-aggregate / `currentState` point-read meta-metrics, #848) reflects PM
  // VOLUME / a moving-population membership delta, NOT the deployed code — excluded here exactly as
  // outage-correlated errors + foreign infra/user-state sources are (isExcludedFromDeployRegressionLoop,
  // reusing #848's registry flags as the single source of truth). A genuine windowed-aggregate kpi_drift,
  // an error-rate loop, or a test/regression loop is NOT excluded and still trips `regressed`.
  const { data: alertRows } = await admin
    .from("loop_alerts")
    .select("loop_id, reason, detail, opened_at, status")
    .eq("status", "open")
    .gte("opened_at", deployedAt)
    .lte("opened_at", watch.window_ends_at);
  const newRedLoops: Array<{ loop_id: string; reason: string; detail: string }> = [];
  const excludedRedLoops: Array<{ loop_id: string; excluded_reason: string }> = [];
  for (const r of ((alertRows as Array<{ loop_id: string; reason: string; detail: string }> | null) || [])) {
    if (!r.loop_id || baselineLoopIds.has(r.loop_id)) continue;
    const excluded = reasonExcludedFromDeployRegressionLoop(r.loop_id);
    if (excluded) {
      excludedRedLoops.push({ loop_id: r.loop_id, excluded_reason: excluded });
      continue;
    }
    newRedLoops.push({ loop_id: r.loop_id, reason: r.reason, detail: r.detail });
  }

  // Live Control-Tower snapshot — a cross-check on the current red-loop count (Tao's signals reused).
  let redLoopCount: number | null = null;
  let controlTowerOk = true;
  try {
    const snap = await buildControlTowerSnapshot(admin);
    redLoopCount = snap.counts.red;
  } catch (e) {
    controlTowerOk = false;
    console.warn("[deploy-guardian] control-tower snapshot failed:", e instanceof Error ? e.message : e);
  }

  return { newErrorSignatures, newRedLoops, excludedRedLoops, redLoopCount, controlTowerOk };
}

/** The findings-derived subset of `DeployVerdict` — the three values `verdictFor` can return. */
export type FindingsVerdict = "healthy" | "regressed" | "unsure";

/**
 * The verdict rule. `regressed` = a clear deploy-correlated spike (a new red loop, OR a clear new-error
 * spike). `healthy` = nothing new attributable to the deploy. `unsure` = some new signal that doesn't
 * clearly clear the spike bar. `verdictFor` NEVER returns `in_review` — that's a lifecycle state the
 * cron stamps when it enqueues a Reva box-session review job (reva-box-session-causal-rollback Phase 1).
 */
export function verdictFor(f: DeployWatchFindings): FindingsVerdict {
  if (f.newRedLoops.length > 0) return "regressed"; // a monitored loop flipped red after the deploy
  const sigs = f.newErrorSignatures;
  if (sigs.length === 0) return "healthy"; // no new deploy-correlated error, no new red loop
  const distinct = new Set(sigs.map((s) => s.signature)).size;
  const maxCount = sigs.reduce((m, s) => Math.max(m, s.count), 0);
  if (distinct >= DEPLOY_REGRESSION_MIN_SIGNATURES || maxCount >= DEPLOY_REGRESSION_MIN_COUNT) return "regressed";
  return "unsure"; // a single new low-count signature — ambiguous, could be foreign transient noise
}

// ── Phase 2 — restore known-good (the revert) ────────────────────────────────

export interface RevertResult {
  reverted: boolean;
  /** the revert commit's SHA (when `reverted`). */
  revertSha?: string | null;
  /** why a revert didn't happen (when `!reverted`). */
  reason?: string;
  /** a later commit touched the same files (a true `git revert` conflict) ⇒ escalate, don't clobber. */
  conflict?: boolean;
}

/** Read a `.commit.tree.sha` off a `/commits/{sha}` response. */
function treeShaOf(commitJson: Record<string, unknown>): string {
  const commit = commitJson.commit as { tree?: { sha?: string } } | undefined;
  return String(commit?.tree?.sha || "");
}

interface ChangedFile {
  filename?: string;
  status?: string;
  sha?: string;
  previous_filename?: string;
}
interface TreeBlob {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
}

/**
 * Build the revert TREE for the not-fast-forward case (a later deploy landed on top of the offending one):
 * a TRUE single-commit revert — undo ONLY this deploy's files, on top of the current HEAD tree. Each of the
 * commit's files is restored to its parent (good) version, BUT only if no later commit touched that path
 * (else it's exactly the conflict `git revert` would raise → bail so the caller escalates instead of
 * clobbering an unrelated later change). Returns the new tree SHA, or a conflict/error reason.
 */
async function buildRevertTree(args: {
  files: ChangedFile[];
  parentTreeSha: string;
  headTreeSha: string;
}): Promise<{ ok: boolean; treeSha?: string; reason?: string }> {
  const [pRes, hRes] = await Promise.all([
    gh("GET", `/repos/${GH_REPO}/git/trees/${args.parentTreeSha}?recursive=1`),
    gh("GET", `/repos/${GH_REPO}/git/trees/${args.headTreeSha}?recursive=1`),
  ]);
  if (!pRes.ok || !hRes.ok) return { ok: false, reason: "couldn't read parent/head tree" };
  // A truncated tree is too large to reason about safely — escalate rather than risk a partial revert.
  if (pRes.json.truncated === true || hRes.json.truncated === true) return { ok: false, reason: "tree too large to revert safely" };

  const toMap = (json: Record<string, unknown>): Map<string, { sha: string; mode: string }> => {
    const m = new Map<string, { sha: string; mode: string }>();
    for (const e of (json.tree as TreeBlob[] | undefined) || []) {
      if (e.type === "blob" && e.path && e.sha) m.set(e.path, { sha: e.sha, mode: e.mode || "100644" });
    }
    return m;
  };
  const pMap = toMap(pRes.json);
  const hMap = toMap(hRes.json);

  const entries: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [];
  const restore = (path: string) => {
    const p = pMap.get(path);
    if (p) entries.push({ path, mode: p.mode, type: "blob", sha: p.sha });
    else entries.push({ path, mode: "100644", type: "blob", sha: null }); // absent in parent ⇒ delete
  };

  for (const f of args.files) {
    const path = String(f.filename || "");
    if (!path) continue;
    const status = String(f.status || "");
    const cBlob = typeof f.sha === "string" ? f.sha : "";
    if (status === "added") {
      // C added it ⇒ revert deletes it. Safe only if HEAD still holds C's exact blob (not edited since).
      const h = hMap.get(path);
      if (!h || h.sha !== cBlob) return { ok: false, reason: `later change to ${path} — conflict` };
      entries.push({ path, mode: h.mode, type: "blob", sha: null });
    } else if (status === "removed") {
      // C deleted it ⇒ revert restores it from the parent. Safe only if HEAD still lacks it (not re-added).
      if (hMap.has(path)) return { ok: false, reason: `${path} re-added after the deploy — conflict` };
      restore(path);
    } else if (status === "modified" || status === "changed") {
      const h = hMap.get(path);
      if (!h || h.sha !== cBlob) return { ok: false, reason: `later change to ${path} — conflict` };
      restore(path);
    } else if (status === "renamed") {
      const prev = typeof f.previous_filename === "string" ? f.previous_filename : "";
      const h = hMap.get(path);
      if (!h || h.sha !== cBlob) return { ok: false, reason: `later change to ${path} — conflict` };
      entries.push({ path, mode: h.mode, type: "blob", sha: null }); // drop the new name
      if (prev) {
        if (hMap.has(prev)) return { ok: false, reason: `${prev} re-created after the deploy — conflict` };
        restore(prev); // bring back the old name
      }
    } else {
      return { ok: false, reason: `unsupported file status '${status}' on ${path}` };
    }
  }
  if (entries.length === 0) return { ok: false, reason: "no file changes to revert" };

  const treeRes = await gh("POST", `/repos/${GH_REPO}/git/trees`, { base_tree: args.headTreeSha, tree: entries });
  if (!treeRes.ok) return { ok: false, reason: `create tree failed (${treeRes.status})` };
  const treeSha = String(treeRes.json.sha || "");
  return treeSha ? { ok: true, treeSha } : { ok: false, reason: "no tree sha" };
}

/**
 * Restore known-good by reverting the offending squash-merge commit, via the GitHub git-data API (no local
 * git — the cron runs in the Vercel/Inngest runtime). A squash merge is a single-parent commit, so:
 *  - if nothing landed since (HEAD === the merge), restore the parent's tree VERBATIM — the prior good build,
 *    byte-for-byte (the common case under the serialized auto-merge gate);
 *  - else do a TRUE single-commit revert of only this deploy's files ({@link buildRevertTree}), escalating
 *    instead of clobbering if a later commit touched them.
 * Never throws — returns a structured result; the caller escalates on `!reverted`.
 */
export async function revertDeployMerge(args: {
  mergeSha: string | null;
  slug: string;
  prNumber?: number | null;
}): Promise<RevertResult> {
  try {
    if (!ghToken()) return { reverted: false, reason: "no GitHub token configured" };
    const mergeSha = args.mergeSha || "";
    if (!mergeSha) return { reverted: false, reason: "no merge SHA on the watch — can't identify the deploy to revert" };

    // The commit we're undoing + its single parent (the prior good state).
    const cRes = await gh("GET", `/repos/${GH_REPO}/commits/${mergeSha}`);
    if (!cRes.ok) return { reverted: false, reason: `commit ${mergeSha.slice(0, 7)} not found (${cRes.status})` };
    const parents = (cRes.json.parents as Array<{ sha?: string }> | undefined) || [];
    if (parents.length !== 1) {
      // A squash merge is always single-parent; anything else (a real merge commit, a root commit) we don't auto-revert.
      return { reverted: false, conflict: true, reason: `commit has ${parents.length} parent(s) — not a squash merge` };
    }
    const parentSha = String(parents[0].sha || "");
    const files = (cRes.json.files as ChangedFile[] | undefined) || [];

    // Current main HEAD — the revert lands on top of it.
    const refRes = await gh("GET", `/repos/${GH_REPO}/git/ref/heads/${MAIN_BRANCH}`);
    if (!refRes.ok) return { reverted: false, reason: `couldn't read ${MAIN_BRANCH} ref (${refRes.status})` };
    const headSha = String((refRes.json.object as { sha?: string } | undefined)?.sha || "");
    if (!headSha) return { reverted: false, reason: "couldn't resolve HEAD sha" };

    let newTreeSha: string;
    if (headSha === mergeSha) {
      // Fast path: nothing landed since — restore the parent tree exactly (the prior good build).
      const pRes = await gh("GET", `/repos/${GH_REPO}/commits/${parentSha}`);
      newTreeSha = treeShaOf(pRes.json);
      if (!newTreeSha) return { reverted: false, reason: "couldn't resolve the parent tree" };
    } else {
      // Later deploy(s) on top — true single-commit revert of just this deploy's files. The commits API
      // caps `files` at 300; a bigger diff can't be reverted file-by-file with confidence → escalate.
      if (files.length >= 300) return { reverted: false, conflict: true, reason: "deploy changed ≥300 files — too large to revert file-by-file with a later deploy on top" };
      const [pRes, hRes] = await Promise.all([
        gh("GET", `/repos/${GH_REPO}/commits/${parentSha}`),
        gh("GET", `/repos/${GH_REPO}/commits/${headSha}`),
      ]);
      const parentTreeSha = treeShaOf(pRes.json);
      const headTreeSha = treeShaOf(hRes.json);
      if (!parentTreeSha || !headTreeSha) return { reverted: false, reason: "couldn't resolve parent/head tree" };
      const built = await buildRevertTree({ files, parentTreeSha, headTreeSha });
      if (!built.ok) return { reverted: false, conflict: true, reason: built.reason };
      newTreeSha = built.treeSha as string;
    }

    // Create the revert commit on top of HEAD, then advance main (non-force — it's a fast-forward child).
    const message =
      `Revert "${args.slug}"${args.prNumber ? ` (#${args.prNumber})` : ""}\n\n` +
      `Auto-rollback by Reva (Deploy Guardian): deploy ${mergeSha.slice(0, 7)} introduced a deploy-correlated ` +
      `regression over its canary window. Restoring the prior good build — a revert is itself reversible ` +
      `(revert-of-a-revert re-lands the fix). deploy-health-rollback-guardian Phase 2.`;
    const commitRes = await gh("POST", `/repos/${GH_REPO}/git/commits`, { message, tree: newTreeSha, parents: [headSha] });
    if (!commitRes.ok) return { reverted: false, reason: `create revert commit failed (${commitRes.status})` };
    const revertSha = String(commitRes.json.sha || "");
    if (!revertSha) return { reverted: false, reason: "no revert commit sha returned" };

    const upd = await gh("PATCH", `/repos/${GH_REPO}/git/refs/heads/${MAIN_BRANCH}`, { sha: revertSha, force: false });
    if (!upd.ok) {
      const m = upd.json.message;
      return { reverted: false, reason: `advancing ${MAIN_BRANCH} to the revert failed (${upd.status}${m ? `: ${String(m)}` : ""})` };
    }
    return { reverted: true, revertSha };
  } catch (e) {
    return { reverted: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Count this slug's prior auto-rollbacks in the reland window (the loop-guard ledger). */
async function priorRollbacksForSlug(admin: Admin, workspaceId: string, slug: string): Promise<number> {
  const sinceIso = new Date(Date.now() - RELAND_WINDOW_MS).toISOString();
  const { count } = await admin
    .from("director_activity")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("director_function", GUARDIAN_FUNCTION)
    .eq("action_kind", "deploy_rolled_back")
    .eq("spec_slug", slug)
    .gte("created_at", sinceIso);
  return count ?? 0;
}

/** A short human description of what regressed (for the CEO diagnosis + the activity reason). */
function describeRegression(f: DeployWatchFindings): string {
  const bits: string[] = [];
  if (f.newRedLoops.length) bits.push(`${f.newRedLoops.length} new red loop(s) (${f.newRedLoops.map((l) => l.loop_id).join(", ")})`);
  if (f.newErrorSignatures.length) bits.push(`${f.newErrorSignatures.length} new error signature(s): ${f.newErrorSignatures.slice(0, 5).map((s) => s.signature).join("; ")}`);
  return bits.join("; ") || "a deploy-correlated regression";
}

/**
 * Evaluate ONE watch: gather findings → verdict → CLAIM the row (atomic, idempotent) → ACT.
 *
 * reva-box-session-causal-rollback Phase 1 — the cron STOPS DECIDING. The healthy path is unchanged
 * (verdictFor cheaply proves 'nothing new' → stamp healthy + record activity). On a NON-healthy
 * findings verdict, the cron enqueues a `kind='deploy-review'` agent_jobs row (Reva's Max session
 * reads the diff + judges per-signal causal plausibility) and stamps the watch `verdict='in_review'`
 * instead of reverting/escalating directly. The pending-window read filters `verdict='pending'`, so
 * an `in_review` watch is naturally excluded from re-evaluation — a re-tick cannot double-enqueue.
 *
 * Preserved: the ATOMIC-goal escalate branch (a whole-goal deploy always escalates instead of routing
 * a per-signal review); the LOOP-GUARD pre-check (a slug that already hit `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`
 * prior auto-rollbacks escalates and does NOT enqueue — a rollback-then-reland loop is a deeper issue).
 * Only the evaluator that wins the `pending → verdict` claim acts, so a concurrent re-run never
 * double-enqueues (the same idempotency spine that guarded the revert).
 */
export async function evaluateDeployWatch(admin: Admin, watch: DeployWatch): Promise<DeployVerdict> {
  const findings = await gatherDeployFindings(admin, watch);
  const verdict = verdictFor(findings);

  const findingsJson: Record<string, unknown> = {
    newErrorSignatures: findings.newErrorSignatures,
    newRedLoops: findings.newRedLoops,
    excludedRedLoops: findings.excludedRedLoops,
    redLoopCount: findings.redLoopCount,
    controlTowerOk: findings.controlTowerOk,
  };

  // ── HEALTHY: unchanged fast path (nothing new attributable → stamp + activity, no session). ───
  if (verdict === "healthy") {
    const { data: healthyClaimed } = await admin
      .from("deploy_watches")
      .update({ verdict: "healthy", evaluated_at: new Date().toISOString(), findings: findingsJson })
      .eq("id", watch.id)
      .eq("verdict", "pending")
      .select("id");
    if (!healthyClaimed || healthyClaimed.length === 0) {
      console.log(`[deploy-guardian] ${watch.branch} → healthy (already claimed by a concurrent tick — no action)`);
      return "healthy";
    }
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_healthy",
      specSlug: watch.slug,
      reason: `Deploy of ${watch.slug} (${watch.branch}) clean over the ${Math.round(CANARY_WINDOW_MS / 60000)}m canary window — no new deploy-correlated error or red loop.`,
      metadata: deployActivityMeta(watch, "healthy", findings),
    });
    console.log(`[deploy-guardian] ${watch.branch} → healthy`);
    return "healthy";
  }

  // ── ATOMIC non-healthy: preserved escalate path (never route a whole-goal deploy through a per-
  //    signal causal review — reverting a goal-sized deploy is far costlier than a per-phase revert). ──
  if (watch.is_atomic) {
    const { data: atomicClaimed } = await admin
      .from("deploy_watches")
      .update({ verdict, evaluated_at: new Date().toISOString(), findings: findingsJson })
      .eq("id", watch.id)
      .eq("verdict", "pending")
      .select("id");
    if (!atomicClaimed || atomicClaimed.length === 0) {
      console.log(`[deploy-guardian] ${watch.branch} → ${verdict} (atomic; already claimed by a concurrent tick — no action)`);
      return verdict;
    }
    if (verdict === "unsure") {
      const diagnosis = `Deploy of "${watch.slug}" (${watch.branch}) shows an AMBIGUOUS post-deploy signal (${findings.newErrorSignatures.length} new low-count error signature(s)) that doesn't clearly clear the regression bar. Reva won't auto-revert on an unsure signal — please eyeball it: ${describeRegression(findings)}.`;
      await safeEscalate(admin, watch, { title: `Ambiguous post-deploy signal: ${watch.slug}`, diagnosis, dedupeKey: `deploy-unsure:${watch.id}`, escalationKind: "deploy_unsure" });
      await recordDirectorActivity(admin, {
        workspaceId: watch.workspace_id,
        directorFunction: GUARDIAN_FUNCTION,
        actionKind: "deploy_unsure",
        specSlug: watch.slug,
        reason: diagnosis,
        metadata: deployActivityMeta(watch, "unsure", findings, { atomic: true }),
      });
      console.log(`[deploy-guardian] ${watch.branch} → unsure (atomic; escalated, no revert)`);
      return "unsure";
    }
    // atomic regressed
    const diagnosis = `ATOMIC goal promotion "${watch.slug}" (${watch.branch}) shows a post-deploy REGRESSION over the ${Math.round(CANARY_WINDOW_MS / 60000)}m canary window: ${describeRegression(findings)}. This deploy landed a whole goal (many specs) on main in one merge — Reva will NOT auto-revert a goal-sized deploy (the regression bar is tuned for small per-phase diffs; reverting the whole goal would discard many specs' tested work). Please decide: revert the goal merge, hotfix-forward, or accept.`;
    await safeEscalate(admin, watch, {
      title: `Regression on atomic goal promotion: ${watch.slug} — manual rollback decision needed`,
      diagnosis,
      dedupeKey: `deploy-atomic-regressed:${watch.id}`,
      escalationKind: "deploy_atomic_regressed",
      metadata: deployActivityMeta(watch, "regressed", findings, { atomic: true }),
    });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_atomic_regressed",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: deployActivityMeta(watch, "regressed", findings, { atomic: true }),
    });
    console.log(`[deploy-guardian] ${watch.branch} → ATOMIC regressed (escalated, NO auto-revert of a whole goal)`);
    return "regressed";
  }

  // ── LOOP-GUARD pre-check (per-spec, non-atomic): a slug that already hit MAX prior auto-rollbacks
  //    is stuck in a rollback-then-reland loop — a deeper issue, not a per-signal review candidate.
  //    Stamp `regressed` + escalate + halt, DON'T spawn a Reva session (spec verification bullet). ──
  const priorRollbacks = await priorRollbacksForSlug(admin, watch.workspace_id, watch.slug);
  if (priorRollbacks >= DEPLOY_GUARDIAN_LOOP_GUARD_MAX) {
    const { data: guardedClaim } = await admin
      .from("deploy_watches")
      .update({ verdict: "regressed", evaluated_at: new Date().toISOString(), findings: findingsJson })
      .eq("id", watch.id)
      .eq("verdict", "pending")
      .select("id");
    if (!guardedClaim || guardedClaim.length === 0) {
      console.log(`[deploy-guardian] ${watch.branch} → loop-guard (already claimed by a concurrent tick — no action)`);
      return "regressed";
    }
    const what = describeRegression(findings);
    const diagnosis = `Deploy of "${watch.slug}" (${watch.branch}) regressed AGAIN after ${priorRollbacks} prior auto-rollback(s) — the rollback-then-reland cycle is looping (a deeper issue, not a flaky deploy). I've STOPPED auto-reverting this slug; it needs a human to fix the root cause or pause its auto-merge. Latest regression: ${what}.`;
    await safeEscalate(admin, watch, { title: `Deploy loop: ${watch.slug} keeps regressing — auto-rollback halted`, diagnosis, dedupeKey: `deploy-loopguard:${watch.id}`, escalationKind: "deploy_loop_guard", metadata: { prior_rollbacks: priorRollbacks } });
    await notifyOpsAlert(watch.workspace_id, {
      title: `Deploy loop-guard tripped: ${watch.slug} regressed ${priorRollbacks + 1}×`,
      severity: "critical",
      lines: [`Stopped auto-reverting "${watch.slug}" after ${priorRollbacks} rollback(s) — the fix keeps re-breaking on reland. A human needs to fix the root cause or pause its auto-merge.`, what],
    });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_regressed",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: deployActivityMeta(watch, "regressed", findings, { loop_guard: true, prior_rollbacks: priorRollbacks }),
    });
    await recordRollbackOutcome(admin, watch, findingsJson, { status: "loop_guard", prior_rollbacks: priorRollbacks });
    console.log(`[deploy-guardian] ${watch.branch} → regressed but LOOP-GUARDED (${priorRollbacks} prior rollbacks) — escalated, no revert, no session enqueue`);
    return "regressed";
  }

  // ── Non-healthy per-spec, no loop-guard: CLAIM (pending → in_review) + enqueue Reva box session.
  //    The atomic claim is the enqueue idempotency spine — only the tick that wins routes a session. ──
  const { data: reviewClaim } = await admin
    .from("deploy_watches")
    .update({ verdict: "in_review", evaluated_at: new Date().toISOString(), findings: findingsJson })
    .eq("id", watch.id)
    .eq("verdict", "pending")
    .select("id");
  if (!reviewClaim || reviewClaim.length === 0) {
    console.log(`[deploy-guardian] ${watch.branch} → in_review (already claimed by a concurrent tick — no action)`);
    return "in_review";
  }
  await enqueueDeployReviewJob(admin, watch, verdict, findings);
  console.log(`[deploy-guardian] ${watch.branch} → in_review (Reva review job enqueued; findings verdict=${verdict})`);
  return "in_review";
}

/**
 * Enqueue exactly one `kind='deploy-review'` agent_jobs row for a watch that just claimed
 * `verdict='in_review'`. Idempotency is upstream: only the cron tick that wins the atomic
 * `pending → in_review` update reaches this helper, so a re-tick cannot double-enqueue. `spec_slug` =
 * the watch slug (mirrors the build-job shape); `spec_branch` = the merged claude/* branch;
 * `instructions` = the JSON brief the Phase-2 Reva session loads (watch id + merge_sha + candidate
 * signals + the findings-derived starting verdict). Best-effort — a throw here is logged but doesn't
 * unstamp the watch (Phase 4's fail-safe backstops a stuck in_review row via the box worker).
 */
async function enqueueDeployReviewJob(
  admin: Admin,
  watch: DeployWatch,
  findingsVerdict: FindingsVerdict,
  findings: DeployWatchFindings,
): Promise<void> {
  try {
    const instructions = {
      watch_id: watch.id,
      slug: watch.slug,
      branch: watch.branch,
      merge_sha: watch.merge_sha,
      pr_number: watch.pr_number,
      deployed_at: watch.deployed_at,
      window_ends_at: watch.window_ends_at,
      is_atomic: !!watch.is_atomic,
      findings_verdict: findingsVerdict,
      new_error_signatures: findings.newErrorSignatures,
      new_red_loops: findings.newRedLoops,
      excluded_red_loops: findings.excludedRedLoops,
      red_loop_count: findings.redLoopCount,
      control_tower_ok: findings.controlTowerOk,
    };
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: watch.workspace_id,
      spec_slug: watch.slug,
      spec_branch: watch.branch,
      pr_number: watch.pr_number ?? null,
      kind: "deploy-review",
      status: "queued",
      instructions: JSON.stringify(instructions),
    });
    if (error) {
      console.warn(`[deploy-guardian] enqueueDeployReviewJob failed for ${watch.slug} (${watch.branch}):`, error.message);
    }
  } catch (e) {
    console.warn("[deploy-guardian] enqueueDeployReviewJob threw:", e instanceof Error ? e.message : e);
  }
}

/** Shared director_activity metadata for a deploy verdict row. */
function deployActivityMeta(watch: DeployWatch, verdict: DeployVerdict, findings: DeployWatchFindings, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    actor: GUARDIAN_ACTOR, // Reva — names the worker that took the action under the supervising platform director.
    deploy_watch_id: watch.id,
    branch: watch.branch,
    pr_number: watch.pr_number,
    merge_sha: watch.merge_sha,
    verdict,
    new_error_signatures: findings.newErrorSignatures.length,
    new_red_loops: findings.newRedLoops.map((l) => l.loop_id),
    // Which loops opened in the window but were dropped as not causally deploy-scoped (monthly kpi_drift,
    // audit-skipped meta-metrics). Surfaced on the activity row so the supervisor can audit the reasoning.
    excluded_red_loops: findings.excludedRedLoops,
    red_loop_count: findings.redLoopCount,
    ...(extra ?? {}),
  };
}

/** Escalate to the CEO via the platform-director plumbing — best-effort, never throws. */
async function safeEscalate(
  admin: Admin,
  watch: DeployWatch,
  args: { title: string; diagnosis: string; dedupeKey: string; escalationKind: string; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    const r = await escalateDiagnosisToCeo(admin, {
      workspaceId: watch.workspace_id,
      specSlug: watch.slug,
      title: args.title,
      diagnosis: args.diagnosis,
      dedupeKey: args.dedupeKey,
      deepLink: `/dashboard/roadmap/${watch.slug}`,
      escalationKind: args.escalationKind,
      metadata: { deploy_watch_id: watch.id, branch: watch.branch, merge_sha: watch.merge_sha, ...(args.metadata ?? {}) },
    });
    if (!r.emitted && r.error) console.error(`[deploy-guardian] CEO escalation failed (${args.dedupeKey}): ${r.error.message}`);
  } catch (e) {
    console.error(`[deploy-guardian] CEO escalation threw (${args.dedupeKey}):`, e instanceof Error ? e.message : e);
  }
}

/** Merge the rollback outcome into the watch's findings (best-effort — the verdict is already stamped). */
async function recordRollbackOutcome(admin: Admin, watch: DeployWatch, base: Record<string, unknown>, rollback: Record<string, unknown>): Promise<void> {
  try {
    await admin.from("deploy_watches").update({ findings: { ...base, rollback } }).eq("id", watch.id);
  } catch (e) {
    console.warn(`[deploy-guardian] recording rollback outcome for ${watch.id} failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Paths a Vercel deploy ships that DON'T enter the runtime: brain docs, markdown/spec text, the SQL
 * migration LEDGER (already applied out-of-band — shipping the file doesn't re-run it), config/lockfiles
 * that don't change behavior on their own. A deploy whose ENTIRE diff is these can't introduce a runtime
 * regression, so a correlated red signal is foreign noise, not this deploy. Conservative: any path NOT
 * matched here (a `.ts`/`.tsx`/`.js` source file, an env/route change) counts as runtime-bearing.
 */
function isRuntimeInertPath(path: string): boolean {
  const p = path.toLowerCase();
  if (p.startsWith("docs/")) return true; // brain pages + docs
  if (/\.(md|mdx|txt)$/.test(p)) return true; // markdown / spec text
  if (p.startsWith("supabase/migrations/")) return true; // migration ledger — applied out-of-band, not at deploy
  if (/\.(json|lock|ya?ml|toml)$/.test(p) && !/^(vercel|next\.config|middleware)/.test(p)) return true; // non-behavioral config
  return false;
}

/**
 * Diff-plausibility gate: fetch the deploy's changed files and decide whether the diff could plausibly cause
 * a RUNTIME regression. A no-op / docs-only / migration-ledger-only / test-marker-only diff (every changed
 * path {@link isRuntimeInertPath}) is incapable of a functional/runtime regression — so a red signal in its
 * canary window is foreign, and auto-reverting it is a false positive (the `noop-pipeline-test-6` incident).
 * Returns `{ inert: true }` for such a diff (caller escalates instead of reverting), `{ inert: false }`
 * otherwise. On any GitHub error / unreadable diff we return `{ inert: false, unknown: true }` — fail OPEN to
 * the existing revert path (never SUPPRESS a real rollback because we couldn't read the diff).
 */
async function classifyDeployDiff(mergeSha: string | null): Promise<{ inert: boolean; unknown?: boolean; runtimeFiles?: string[]; totalFiles?: number }> {
  try {
    if (!ghToken() || !mergeSha) return { inert: false, unknown: true };
    const cRes = await gh("GET", `/repos/${GH_REPO}/commits/${mergeSha}`);
    if (!cRes.ok) return { inert: false, unknown: true };
    const files = ((cRes.json.files as ChangedFile[] | undefined) || []).map((f) => String(f.filename || "")).filter(Boolean);
    if (files.length === 0) return { inert: false, unknown: true }; // can't read the diff — fail open
    const runtimeFiles = files.filter((f) => !isRuntimeInertPath(f));
    return { inert: runtimeFiles.length === 0, runtimeFiles, totalFiles: files.length };
  } catch {
    return { inert: false, unknown: true };
  }
}

/**
 * Phase 2 action on a `regressed` deploy: loop-guard → STOP+escalate; else restore known-good (revert) +
 * escalate the diagnosis carrying the revert; a revert that can't run cleanly escalates for a manual rollback.
 * Records the matching director_activity row (deploy_rolled_back | deploy_regressed) + the rollback findings.
 */
async function actOnRegression(admin: Admin, watch: DeployWatch, findings: DeployWatchFindings, baseFindings: Record<string, unknown>): Promise<void> {
  const what = describeRegression(findings);

  // Diff-plausibility gate: a runtime-inert diff (docs/markdown/migration-ledger/config only — no source
  // code) CANNOT cause a runtime regression, so the correlated red signal is foreign noise, not this deploy.
  // Escalate for human eyes instead of auto-reverting (the `noop-pipeline-test-6` false-revert class). Fails
  // OPEN: a diff we can't read, or one that touches any runtime file, falls through to the revert path.
  const diff = await classifyDeployDiff(watch.merge_sha);
  if (diff.inert) {
    const diagnosis = `Deploy of "${watch.slug}" (${watch.branch}) shows a post-deploy red signal (${what}) over its canary window, but its ENTIRE diff is runtime-INERT (${diff.totalFiles} file(s): docs / markdown / migration-ledger / non-behavioral config — no source code). A runtime-inert deploy cannot introduce a functional regression, so Reva did NOT auto-revert — the signal is almost certainly foreign (e.g. a weekly-aggregate KPI drift or an unrelated incident sharing the window). Please confirm the signal's real cause; re-arm by editing the diff classifier if this WAS the cause.`;
    await safeEscalate(admin, watch, { title: `Red signal on a no-op deploy: ${watch.slug} — NOT auto-reverted (runtime-inert diff)`, diagnosis, dedupeKey: `deploy-inert-noregress:${watch.id}`, escalationKind: "deploy_inert_noregress", metadata: { total_files: diff.totalFiles } });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_unsure",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: deployActivityMeta(watch, "unsure", findings, { runtime_inert_diff: true, total_files: diff.totalFiles }),
    });
    await recordRollbackOutcome(admin, watch, baseFindings, { status: "no_revert_inert_diff", total_files: diff.totalFiles });
    console.log(`[deploy-guardian] ${watch.branch} → regressed signal but RUNTIME-INERT diff (${diff.totalFiles} files) — escalated, NO revert`);
    return;
  }

  const priorRollbacks = await priorRollbacksForSlug(admin, watch.workspace_id, watch.slug);

  // Loop-guard: the same slug already auto-rolled-back ≥ MAX times and regressed AGAIN — a rollback-then-reland
  // loop (a deeper issue). STOP auto-reverting + escalate the deeper issue; don't churn the revert forever.
  if (priorRollbacks >= DEPLOY_GUARDIAN_LOOP_GUARD_MAX) {
    const diagnosis = `Deploy of "${watch.slug}" (${watch.branch}) regressed AGAIN after ${priorRollbacks} prior auto-rollback(s) — the rollback-then-reland cycle is looping (a deeper issue, not a flaky deploy). I've STOPPED auto-reverting this slug; it needs a human to fix the root cause or pause its auto-merge. Latest regression: ${what}.`;
    await safeEscalate(admin, watch, { title: `Deploy loop: ${watch.slug} keeps regressing — auto-rollback halted`, diagnosis, dedupeKey: `deploy-loopguard:${watch.id}`, escalationKind: "deploy_loop_guard", metadata: { prior_rollbacks: priorRollbacks } });
    await notifyOpsAlert(watch.workspace_id, {
      title: `Deploy loop-guard tripped: ${watch.slug} regressed ${priorRollbacks + 1}×`,
      severity: "critical",
      lines: [`Stopped auto-reverting "${watch.slug}" after ${priorRollbacks} rollback(s) — the fix keeps re-breaking on reland. A human needs to fix the root cause or pause its auto-merge.`, what],
    });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_regressed",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: deployActivityMeta(watch, "regressed", findings, { loop_guard: true, prior_rollbacks: priorRollbacks }),
    });
    await recordRollbackOutcome(admin, watch, baseFindings, { status: "loop_guard", prior_rollbacks: priorRollbacks });
    console.log(`[deploy-guardian] ${watch.branch} → regressed but LOOP-GUARDED (${priorRollbacks} prior rollbacks) — escalated, no revert`);
    return;
  }

  // Restore known-good: revert the offending squash-merge.
  const result = await revertDeployMerge({ mergeSha: watch.merge_sha, slug: watch.slug, prNumber: watch.pr_number });

  if (result.reverted) {
    const diagnosis = `Deploy of "${watch.slug}" (${watch.branch}) introduced a deploy-correlated regression — ${what}. Reva auto-rolled it back to the prior good build (revert ${String(result.revertSha).slice(0, 7)} on ${MAIN_BRANCH}); a revert is itself reversible, so re-land the fix once the root cause is understood. Please confirm prod recovered.`;
    await safeEscalate(admin, watch, { title: `Auto-rolled back: ${watch.slug} regressed → restored prior build`, diagnosis, dedupeKey: `deploy-rollback:${watch.id}`, escalationKind: "deploy_rollback", metadata: { revert_sha: result.revertSha } });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_rolled_back",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: deployActivityMeta(watch, "regressed", findings, { revert_sha: result.revertSha, prior_rollbacks: priorRollbacks }),
    });
    await recordRollbackOutcome(admin, watch, baseFindings, { status: "reverted", revert_sha: result.revertSha, prior_rollbacks: priorRollbacks });
    console.log(`[deploy-guardian] ${watch.branch} → regressed → ROLLED BACK (revert ${String(result.revertSha).slice(0, 7)})`);
    return;
  }

  // Couldn't cleanly revert (a real git-revert conflict, a missing SHA, or a GitHub error) — DON'T guess /
  // clobber. Escalate critically for a manual rollback (prod is still on the regressed build).
  const reason = result.reason || "unknown";
  const diagnosis = `Deploy of "${watch.slug}" (${watch.branch}) introduced a deploy-correlated regression — ${what} — but Reva could NOT auto-roll it back (${result.conflict ? "a later commit touched the same files (a revert conflict)" : "the revert couldn't be applied"}: ${reason}). Prod is STILL on the regressed build — please revert it manually.`;
  await safeEscalate(admin, watch, { title: `Regression on ${watch.slug} — AUTO-ROLLBACK FAILED, manual revert needed`, diagnosis, dedupeKey: `deploy-revertfail:${watch.id}`, escalationKind: result.conflict ? "deploy_revert_conflict" : "deploy_revert_failed", metadata: { revert_reason: reason } });
  await notifyOpsAlert(watch.workspace_id, {
    title: `Auto-rollback FAILED: ${watch.slug} regressed and is still live`,
    severity: "critical",
    lines: [`Reva detected a regression on "${watch.slug}" (${watch.branch}) but couldn't auto-revert (${reason}). Prod is still on the regressed build — revert it manually.`, what],
  });
  await recordDirectorActivity(admin, {
    workspaceId: watch.workspace_id,
    directorFunction: GUARDIAN_FUNCTION,
    actionKind: "deploy_regressed",
    specSlug: watch.slug,
    reason: diagnosis,
    metadata: deployActivityMeta(watch, "regressed", findings, { revert_failed: true, conflict: !!result.conflict, revert_reason: reason }),
  });
  await recordRollbackOutcome(admin, watch, baseFindings, { status: result.conflict ? "conflict" : "revert_failed", reason });
  console.log(`[deploy-guardian] ${watch.branch} → regressed but REVERT FAILED (${reason}) — escalated for manual rollback`);
}

export interface EvaluateDueResult {
  due: number;
  evaluated: Array<{ id: string; slug: string; verdict: DeployVerdict }>;
}

/**
 * Driver: find every `pending` watch whose canary window has elapsed and evaluate it. Bounded per tick.
 * Called every minute by [[../inngest/deploy-guardian-cron]]. Best-effort — never throws.
 */
export async function evaluateDueDeployWatches(admin: Admin): Promise<EvaluateDueResult> {
  const out: EvaluateDueResult = { due: 0, evaluated: [] };
  try {
    const nowIso = new Date().toISOString();
    const { data } = await admin
      .from("deploy_watches")
      .select("*")
      .eq("verdict", "pending")
      .lte("window_ends_at", nowIso)
      .order("window_ends_at", { ascending: true })
      .limit(EVAL_BATCH_CAP);
    const watches = (data as DeployWatch[] | null) || [];
    out.due = watches.length;
    for (const w of watches) {
      try {
        const verdict = await evaluateDeployWatch(admin, w);
        out.evaluated.push({ id: w.id, slug: w.slug, verdict });
      } catch (e) {
        console.warn(`[deploy-guardian] evaluate ${w.id} (${w.branch}) threw:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn("[deploy-guardian] evaluateDueDeployWatches threw:", e instanceof Error ? e.message : e);
  }
  return out;
}

// ── Phase 3 — the worker applies Reva's typed verdict (the only mutator) ─────────

/** One per-signal verdict returned by Reva's box session (deploy-review skill). */
export interface RevaSignalVerdict {
  key: string;
  surface: string;
  caused: boolean;
  evidence: string;
}

/** The typed verdict Reva's box session (`kind='deploy-review'`) returns for one watch. */
export interface RevaReviewVerdict {
  decision: "revert" | "keep" | "escalate";
  signals: RevaSignalVerdict[];
  reasoning: string;
}

/** The outcome of applying a `RevaReviewVerdict` to a watch (surfaced back to the runner for its log_tail). */
export interface ApplyBoxDeployReviewResult {
  ok: boolean;
  /** why the apply no-op'd (already claimed, no watch, no in_review row, etc.) — set when `!ok`. */
  reason?: string;
  /** the resulting `deploy_watches.verdict` stamp — 'healthy'/'regressed'/'unsure' (never re-writes 'in_review'). */
  finalVerdict?: DeployVerdict;
  /** on decision='revert' + a clean revert, the revert commit SHA. */
  revertSha?: string | null;
  /** the loop-guard trip surface: a decision='revert' by a slug that already hit MAX prior auto-rollbacks
   *  degrades to escalate (never revert) — the same conservative move Phase 2's actOnRegression made. */
  loopGuarded?: boolean;
}

/** Format Reva's signals for the escalation diagnosis + activity reason (compact, human-legible). */
function describeRevaSignals(v: RevaReviewVerdict): string {
  const caused = v.signals.filter((s) => s.caused);
  const notCaused = v.signals.filter((s) => !s.caused);
  const bits: string[] = [];
  if (caused.length) bits.push(`${caused.length} caused signal(s): ${caused.slice(0, 3).map((s) => `${s.key} → ${s.surface}${s.evidence ? ` (${s.evidence})` : ""}`).join("; ")}`);
  if (notCaused.length) bits.push(`${notCaused.length} not-caused: ${notCaused.slice(0, 3).map((s) => s.key).join(", ")}`);
  return bits.join(" · ") || "no per-signal detail";
}

/** Common activity-metadata slice for a Reva verdict (mirrors deployActivityMeta's shape, minus DeployWatchFindings). */
function revaActivityMeta(watch: DeployWatch, verdict: DeployVerdict, v: RevaReviewVerdict, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    actor: GUARDIAN_ACTOR, // Reva.
    deploy_watch_id: watch.id,
    branch: watch.branch,
    pr_number: watch.pr_number,
    merge_sha: watch.merge_sha,
    verdict,
    reviewed_by: "box-session",
    reva_decision: v.decision,
    reva_signals: v.signals,
    ...(extra ?? {}),
  };
}

/** Write findings.reva_review + (on revert) findings.rollback, preserving all other findings keys. */
async function stampFindingsWithReview(
  admin: Admin,
  watchId: string,
  currentFindings: Record<string, unknown> | null,
  v: RevaReviewVerdict,
  rollback?: Record<string, unknown>,
): Promise<void> {
  try {
    const base = currentFindings ?? {};
    const patch: Record<string, unknown> = {
      ...base,
      reva_review: { decision: v.decision, signals: v.signals, reasoning: v.reasoning, reviewed_by: "box-session" },
    };
    if (rollback) patch.rollback = rollback;
    await admin.from("deploy_watches").update({ findings: patch }).eq("id", watchId);
  } catch (e) {
    console.warn(`[deploy-guardian] stampFindingsWithReview failed for ${watchId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Apply Reva's typed causal-review verdict to the watch behind ONE `kind='deploy-review'` agent_jobs
 * row (reva-box-session-causal-rollback Phase 3 — the **only mutator** on the box-session path).
 * Mirrors `applyBoxGrade` in shape: the box session diagnoses read-only + returns a typed verdict; this
 * deterministic writer claims the row atomically and applies it. **Idempotent + concurrency-safe:**
 * the atomic pending-guard is `update deploy_watches set … where verdict='in_review' returning id`
 * — only the caller that wins the claim acts, so a re-apply / a concurrent tick / a redriven job never
 * double-reverts.
 *
 * Decisions:
 * - `revert` — check the LOOP-GUARD first (`priorRollbacksForSlug` ≥ `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`).
 *   If tripped: escalate + stamp `verdict='regressed'` + `findings.rollback={status:'loop_guard'…}` +
 *   `deploy_regressed` activity (same conservative move actOnRegression made — a rollback-then-reland
 *   loop is a deeper issue, not a per-signal review candidate). Else: call `revertDeployMerge` (:584);
 *   on a clean revert stamp `verdict='regressed'` + `findings.rollback={status:'reverted', revert_sha,
 *   prior_rollbacks}` + escalate + `deploy_rolled_back` activity. A conflict/failed revert stamps
 *   `verdict='regressed'` + `findings.rollback={status:'revert_failed'|'conflict', reason}` + a critical
 *   ops alert + `deploy_regressed` activity (prod still on the regressed build — manual revert needed).
 * - `keep` — stamp `verdict='healthy'` + `deploy_kept` activity (no revert, no escalation — Reva
 *   affirmed no causal path). Reasoning goes on the activity row.
 * - `escalate` — stamp `verdict='unsure'` + escalate the plausible-but-unconfirmable case + `deploy_unsure`
 *   activity (never revert on doubt).
 *
 * Every path writes `findings.reva_review = { decision, signals, reasoning, reviewed_by:'box-session' }`
 * — the audit surface for the reasoning that drove the mutation. **Never throws** — returns a structured
 * result so the caller can log it on the agent_jobs row (the runner is Phase 2's `runDeployReviewJob`).
 */
export async function applyBoxDeployReview(admin: Admin, jobId: string, verdict: RevaReviewVerdict): Promise<ApplyBoxDeployReviewResult> {
  try {
    // Resolve the watch id: prefer instructions.watch_id (the enqueue payload), fall back to spec_slug
    // (which is the watch's slug, not id) via a latest-in_review lookup. The enqueue path always writes
    // a JSON `instructions` string with `watch_id`, so the fallback is defensive against a stripped row.
    const { data: jobRow } = await admin
      .from("agent_jobs")
      .select("id, workspace_id, kind, spec_slug, instructions, status")
      .eq("id", jobId)
      .maybeSingle();
    if (!jobRow) return { ok: false, reason: "job_not_found" };
    const job = jobRow as { id: string; workspace_id: string; kind: string; spec_slug: string; instructions: string | null; status: string };
    if (job.kind !== "deploy-review") return { ok: false, reason: `wrong_kind:${job.kind}` };

    let watchId: string | null = null;
    try {
      const parsed = job.instructions ? (JSON.parse(job.instructions) as { watch_id?: string }) : null;
      if (parsed?.watch_id) watchId = String(parsed.watch_id);
    } catch { /* fall through to the fallback below */ }
    if (!watchId) {
      const { data: latest } = await admin
        .from("deploy_watches")
        .select("id")
        .eq("workspace_id", job.workspace_id)
        .eq("slug", job.spec_slug)
        .eq("verdict", "in_review")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = latest as { id: string } | null;
      if (row?.id) watchId = row.id;
    }
    if (!watchId) return { ok: false, reason: "watch_not_found" };

    // Read the watch to work off (findings + slug/merge_sha for the mutator hands).
    const { data: watchRow } = await admin.from("deploy_watches").select("*").eq("id", watchId).maybeSingle();
    if (!watchRow) return { ok: false, reason: "watch_row_gone" };
    const watch = watchRow as DeployWatch;
    if (watch.verdict !== "in_review") {
      // The watch is already past `in_review` — a re-apply (retry / concurrent tick) that lost the
      // claim. No-op idempotently instead of stamping a stale verdict on top of a later one.
      return { ok: false, reason: `watch_not_in_review:${watch.verdict}`, finalVerdict: watch.verdict as DeployVerdict };
    }
    const currentFindings = watch.findings ?? {};

    // ── decision === 'keep' — Reva affirmed no causal path; stamp healthy, no revert, no escalation.
    if (verdict.decision === "keep") {
      const { data: claimed } = await admin
        .from("deploy_watches")
        .update({ verdict: "healthy", evaluated_at: new Date().toISOString() })
        .eq("id", watch.id)
        .eq("verdict", "in_review")
        .select("id");
      if (!claimed || claimed.length === 0) return { ok: false, reason: "claim_lost", finalVerdict: "healthy" };
      await stampFindingsWithReview(admin, watch.id, currentFindings, verdict);
      const reason = `Reva reviewed the deploy of "${watch.slug}" (${watch.branch}, merge ${(watch.merge_sha || "").slice(0, 7)}) and kept it — every candidate signal has no causal path to the diff. ${describeRevaSignals(verdict)}. Reasoning: ${verdict.reasoning || "(no reasoning)"}.`;
      await recordDirectorActivity(admin, {
        workspaceId: watch.workspace_id,
        directorFunction: GUARDIAN_FUNCTION,
        actionKind: "deploy_kept",
        specSlug: watch.slug,
        reason,
        metadata: revaActivityMeta(watch, "healthy", verdict),
      });
      console.log(`[deploy-guardian] ${watch.branch} → keep (Reva confirmed no causal path — verdict='healthy')`);
      return { ok: true, finalVerdict: "healthy" };
    }

    // ── decision === 'escalate' — plausible but unconfirmed causal path; escalate + verdict='unsure'.
    if (verdict.decision === "escalate") {
      const { data: claimed } = await admin
        .from("deploy_watches")
        .update({ verdict: "unsure", evaluated_at: new Date().toISOString() })
        .eq("id", watch.id)
        .eq("verdict", "in_review")
        .select("id");
      if (!claimed || claimed.length === 0) return { ok: false, reason: "claim_lost", finalVerdict: "unsure" };
      await stampFindingsWithReview(admin, watch.id, currentFindings, verdict);
      const diagnosis = `Reva reviewed the deploy of "${watch.slug}" (${watch.branch}, merge ${(watch.merge_sha || "").slice(0, 7)}) and could construct a plausible causal path for at least one candidate signal but couldn't confirm it — escalating instead of guessing a revert. ${describeRevaSignals(verdict)}. Reasoning: ${verdict.reasoning || "(no reasoning)"}.`;
      await safeEscalate(admin, watch, {
        title: `Deploy review escalated by Reva: ${watch.slug}`,
        diagnosis,
        dedupeKey: `deploy-reva-escalate:${watch.id}`,
        escalationKind: "deploy_reva_escalate",
      });
      await recordDirectorActivity(admin, {
        workspaceId: watch.workspace_id,
        directorFunction: GUARDIAN_FUNCTION,
        actionKind: "deploy_unsure",
        specSlug: watch.slug,
        reason: diagnosis,
        metadata: revaActivityMeta(watch, "unsure", verdict),
      });
      console.log(`[deploy-guardian] ${watch.branch} → escalate (Reva unconfirmed — verdict='unsure', no revert)`);
      return { ok: true, finalVerdict: "unsure" };
    }

    // ── decision === 'revert' — Reva cited a causal path in the diff. Kill-switch first, then loop-guard.
    // Phase-4 kill-switch (`DEPLOY_GUARDIAN_AUTOREVERT_MODE='off'`) → SURFACE-ONLY: never call
    // `revertDeployMerge`. Degrade to the escalate path (still stamps findings.reva_review + writes a
    // `deploy_unsure` activity + escalates), so Reva's verdict is preserved on the audit surface but
    // no code moves. Same shape as the escalate branch above, with a note the mode disabled the revert.
    if (!isAutoRevertEnabled()) {
      const { data: claimed } = await admin
        .from("deploy_watches")
        .update({ verdict: "unsure", evaluated_at: new Date().toISOString() })
        .eq("id", watch.id)
        .eq("verdict", "in_review")
        .select("id");
      if (!claimed || claimed.length === 0) return { ok: false, reason: "claim_lost", finalVerdict: "unsure" };
      await stampFindingsWithReview(admin, watch.id, currentFindings, verdict, { status: "autorevert_off", mode: DEPLOY_GUARDIAN_AUTOREVERT_MODE });
      const diagnosis = `Reva cited a causal path in the deploy of "${watch.slug}" (${watch.branch}, merge ${(watch.merge_sha || "").slice(0, 7)}) — ${describeRevaSignals(verdict)} — BUT the autorevert kill-switch is ON (DEPLOY_GUARDIAN_AUTOREVERT_MODE='off'). The guardian is in SURFACE-ONLY mode; no auto-revert will fire. Please revert manually if the causal path is real. Reasoning: ${verdict.reasoning || "(no reasoning)"}.`;
      await safeEscalate(admin, watch, {
        title: `Deploy revert requested by Reva but SUPPRESSED by kill-switch: ${watch.slug}`,
        diagnosis,
        dedupeKey: `deploy-autorevert-off:${watch.id}`,
        escalationKind: "deploy_autorevert_off",
        metadata: { autorevert_mode: DEPLOY_GUARDIAN_AUTOREVERT_MODE },
      });
      await recordDirectorActivity(admin, {
        workspaceId: watch.workspace_id,
        directorFunction: GUARDIAN_FUNCTION,
        actionKind: "deploy_unsure",
        specSlug: watch.slug,
        reason: diagnosis,
        metadata: revaActivityMeta(watch, "unsure", verdict, { autorevert_mode: DEPLOY_GUARDIAN_AUTOREVERT_MODE }),
      });
      console.log(`[deploy-guardian] ${watch.branch} → revert SUPPRESSED (DEPLOY_GUARDIAN_AUTOREVERT_MODE=off) → verdict='unsure', escalated`);
      return { ok: true, finalVerdict: "unsure" };
    }
    const priorRollbacks = await priorRollbacksForSlug(admin, watch.workspace_id, watch.slug);
    if (priorRollbacks >= DEPLOY_GUARDIAN_LOOP_GUARD_MAX) {
      const { data: claimed } = await admin
        .from("deploy_watches")
        .update({ verdict: "regressed", evaluated_at: new Date().toISOString() })
        .eq("id", watch.id)
        .eq("verdict", "in_review")
        .select("id");
      if (!claimed || claimed.length === 0) return { ok: false, reason: "claim_lost", finalVerdict: "regressed" };
      const rollback = { status: "loop_guard", prior_rollbacks: priorRollbacks };
      await stampFindingsWithReview(admin, watch.id, currentFindings, verdict, rollback);
      const diagnosis = `Reva cited a causal path in the deploy of "${watch.slug}" (${watch.branch}) — ${describeRevaSignals(verdict)} — BUT the slug already auto-rolled-back ${priorRollbacks} time(s) in the last 7 days. The rollback-then-reland cycle is looping (a deeper issue, not a flaky deploy). I've STOPPED auto-reverting this slug; it needs a human to fix the root cause or pause its auto-merge. Reasoning: ${verdict.reasoning || "(no reasoning)"}.`;
      await safeEscalate(admin, watch, { title: `Deploy loop: ${watch.slug} keeps regressing — auto-rollback halted`, diagnosis, dedupeKey: `deploy-loopguard:${watch.id}`, escalationKind: "deploy_loop_guard", metadata: { prior_rollbacks: priorRollbacks } });
      await notifyOpsAlert(watch.workspace_id, {
        title: `Deploy loop-guard tripped: ${watch.slug} regressed ${priorRollbacks + 1}× (Reva review)`,
        severity: "critical",
        lines: [`Stopped auto-reverting "${watch.slug}" after ${priorRollbacks} rollback(s) — the fix keeps re-breaking on reland. A human needs to fix the root cause or pause its auto-merge.`, describeRevaSignals(verdict)],
      });
      await recordDirectorActivity(admin, {
        workspaceId: watch.workspace_id,
        directorFunction: GUARDIAN_FUNCTION,
        actionKind: "deploy_regressed",
        specSlug: watch.slug,
        reason: diagnosis,
        metadata: revaActivityMeta(watch, "regressed", verdict, { loop_guard: true, prior_rollbacks: priorRollbacks }),
      });
      console.log(`[deploy-guardian] ${watch.branch} → revert but LOOP-GUARDED (${priorRollbacks} prior rollbacks) — escalated, no revert`);
      return { ok: true, finalVerdict: "regressed", loopGuarded: true };
    }

    // CLAIM the watch → verdict='regressed' (the revert-eligible stamp). Do this BEFORE calling the
    // revert hand so a re-apply/concurrent tick can't double-revert (the atomic in_review→regressed
    // transition is the idempotency spine — same shape actOnRegression relied on).
    const { data: revertClaim } = await admin
      .from("deploy_watches")
      .update({ verdict: "regressed", evaluated_at: new Date().toISOString() })
      .eq("id", watch.id)
      .eq("verdict", "in_review")
      .select("id");
    if (!revertClaim || revertClaim.length === 0) return { ok: false, reason: "claim_lost", finalVerdict: "regressed" };

    const result = await revertDeployMerge({ mergeSha: watch.merge_sha, slug: watch.slug, prNumber: watch.pr_number });

    if (result.reverted) {
      const rollback = { status: "reverted", revert_sha: result.revertSha, prior_rollbacks: priorRollbacks };
      await stampFindingsWithReview(admin, watch.id, currentFindings, verdict, rollback);
      const diagnosis = `Reva reviewed the deploy of "${watch.slug}" (${watch.branch}) and rolled it back — ${describeRevaSignals(verdict)}. Restored the prior good build (revert ${String(result.revertSha).slice(0, 7)} on ${MAIN_BRANCH}); a revert is itself reversible, so re-land the fix once the root cause is understood. Reasoning: ${verdict.reasoning || "(no reasoning)"}. Please confirm prod recovered.`;
      await safeEscalate(admin, watch, { title: `Auto-rolled back by Reva: ${watch.slug} regressed → restored prior build`, diagnosis, dedupeKey: `deploy-rollback:${watch.id}`, escalationKind: "deploy_rollback", metadata: { revert_sha: result.revertSha } });
      await recordDirectorActivity(admin, {
        workspaceId: watch.workspace_id,
        directorFunction: GUARDIAN_FUNCTION,
        actionKind: "deploy_rolled_back",
        specSlug: watch.slug,
        reason: diagnosis,
        metadata: revaActivityMeta(watch, "regressed", verdict, { revert_sha: result.revertSha, prior_rollbacks: priorRollbacks }),
      });
      console.log(`[deploy-guardian] ${watch.branch} → revert → ROLLED BACK (revert ${String(result.revertSha).slice(0, 7)}) via Reva review`);
      return { ok: true, finalVerdict: "regressed", revertSha: result.revertSha ?? null };
    }

    // Revert couldn't run cleanly (conflict, missing SHA, GitHub error) — prod is STILL on the regressed
    // build. Don't guess/clobber; escalate critically for a manual revert (same shape as actOnRegression).
    const reason = result.reason || "unknown";
    const rollback = { status: result.conflict ? "conflict" : "revert_failed", reason };
    await stampFindingsWithReview(admin, watch.id, currentFindings, verdict, rollback);
    const diagnosis = `Reva cited a causal path in the deploy of "${watch.slug}" (${watch.branch}) — ${describeRevaSignals(verdict)} — but the auto-revert could NOT be applied (${result.conflict ? "a later commit touched the same files (a revert conflict)" : "the revert couldn't be applied"}: ${reason}). Prod is STILL on the regressed build — please revert it manually. Reasoning: ${verdict.reasoning || "(no reasoning)"}.`;
    await safeEscalate(admin, watch, { title: `Regression on ${watch.slug} — AUTO-ROLLBACK FAILED, manual revert needed`, diagnosis, dedupeKey: `deploy-revertfail:${watch.id}`, escalationKind: result.conflict ? "deploy_revert_conflict" : "deploy_revert_failed", metadata: { revert_reason: reason } });
    await notifyOpsAlert(watch.workspace_id, {
      title: `Auto-rollback FAILED: ${watch.slug} regressed and is still live`,
      severity: "critical",
      lines: [`Reva confirmed a regression on "${watch.slug}" (${watch.branch}) but couldn't auto-revert (${reason}). Prod is still on the regressed build — revert it manually.`, describeRevaSignals(verdict)],
    });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_regressed",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: revaActivityMeta(watch, "regressed", verdict, { revert_failed: true, conflict: !!result.conflict, revert_reason: reason }),
    });
    console.log(`[deploy-guardian] ${watch.branch} → revert but REVERT FAILED (${reason}) — escalated for manual rollback`);
    return { ok: true, finalVerdict: "regressed", revertSha: null };
  } catch (e) {
    console.error("[deploy-guardian] applyBoxDeployReview threw:", e instanceof Error ? e.message : e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * FAIL-SAFE ([[../specs/reva-box-session-causal-rollback]] Phase 4): stamp a watch stuck at
 * `verdict='in_review'` to `'unsure'` + escalate, when the Reva box session couldn't return a
 * parseable verdict (session died / idle-killed / hardcap / stream error with no JSON / an
 * exception in the runner). "Never revert without a judgment" — the fail-safe is
 * **keep+escalate, NOT revert**: an unsure stamp is the conservative default because the box
 * session couldn't produce evidence either way.
 *
 * Idempotent + concurrency-safe via the same atomic pending-guard as the mutator
 * (`update … where verdict='in_review' returning id`) — a fail-safe call after a normal
 * `applyBoxDeployReview` no-ops (the watch is already past `in_review`), and a concurrent
 * fail-safe call from a redriven job no-ops on the second caller. Best-effort + **never throws**.
 * Called by `runDeployReviewJob` (scripts/builder-worker.ts) on: (a) unparseable verdict, (b) a
 * thrown catch-block, (c) `applyBoxDeployReview` returned `{ok:false}` with the watch still stuck.
 * Callers pass a `jobId` (for the escalation dedupe key) + a plain-text `reason` — the escalation
 * carries both so the CEO inbox sees why the fail-safe fired.
 */
export async function failsafeStampWatchUnsure(
  admin: Admin,
  args: { jobId: string; reason: string; watchId?: string | null; workspaceId?: string | null; slug?: string | null },
): Promise<{ stamped: boolean; reason?: string; escalated?: boolean }> {
  try {
    // Resolve the watch: prefer the passed watchId (from the enqueue instructions), else look up the
    // latest `in_review` row for (workspaceId, slug) — the runner has all three from the job/instructions.
    let watchId: string | null = args.watchId ?? null;
    if (!watchId && args.workspaceId && args.slug) {
      const { data: latest } = await admin
        .from("deploy_watches")
        .select("id")
        .eq("workspace_id", args.workspaceId)
        .eq("slug", args.slug)
        .eq("verdict", "in_review")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      watchId = (latest as { id: string } | null)?.id ?? null;
    }
    if (!watchId) return { stamped: false, reason: "watch_not_found" };

    const { data: watchRow } = await admin.from("deploy_watches").select("*").eq("id", watchId).maybeSingle();
    if (!watchRow) return { stamped: false, reason: "watch_row_gone" };
    const watch = watchRow as DeployWatch;
    if (watch.verdict !== "in_review") {
      // Already past in_review (a normal apply landed, or another fail-safe won) — no-op.
      return { stamped: false, reason: `not_in_review:${watch.verdict}` };
    }

    // Atomic claim: only the caller that wins the in_review → unsure transition escalates.
    const { data: claimed } = await admin
      .from("deploy_watches")
      .update({ verdict: "unsure", evaluated_at: new Date().toISOString() })
      .eq("id", watch.id)
      .eq("verdict", "in_review")
      .select("id");
    if (!claimed || claimed.length === 0) return { stamped: false, reason: "claim_lost" };

    // Merge a `reva_review` failsafe marker onto findings so the audit trail shows why we didn't apply
    // a typed verdict (the ordinary applyBoxDeployReview never ran to write it).
    try {
      const base = (watch.findings ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {
        ...base,
        reva_review: {
          decision: "escalate",
          signals: [],
          reasoning: args.reason,
          reviewed_by: "box-session-failsafe",
        },
      };
      await admin.from("deploy_watches").update({ findings: patch }).eq("id", watch.id);
    } catch (e) {
      console.warn(`[deploy-guardian] failsafe findings write failed for ${watch.id}:`, e instanceof Error ? e.message : e);
    }

    const diagnosis = `Reva review job ${args.jobId.slice(0, 8)} did not return a parseable verdict for the deploy of "${watch.slug}" (${watch.branch}, merge ${(watch.merge_sha || "").slice(0, 7)}). Fail-safe applied — the watch is stamped 'unsure' and NOT reverted (never revert without a judgment). Reason: ${args.reason}. Please eyeball the deploy manually.`;
    let escalated = false;
    try {
      await safeEscalate(admin, watch, {
        title: `Reva review failed on ${watch.slug} — fail-safe applied (no revert)`,
        diagnosis,
        dedupeKey: `deploy-failsafe:${watch.id}`,
        escalationKind: "deploy_review_failsafe",
        metadata: { job_id: args.jobId, failsafe_reason: args.reason },
      });
      escalated = true;
    } catch (e) {
      console.warn(`[deploy-guardian] failsafe escalation threw for ${watch.id}:`, e instanceof Error ? e.message : e);
    }
    try {
      await recordDirectorActivity(admin, {
        workspaceId: watch.workspace_id,
        directorFunction: GUARDIAN_FUNCTION,
        actionKind: "deploy_unsure",
        specSlug: watch.slug,
        reason: diagnosis,
        metadata: {
          actor: GUARDIAN_ACTOR,
          deploy_watch_id: watch.id,
          branch: watch.branch,
          pr_number: watch.pr_number,
          merge_sha: watch.merge_sha,
          verdict: "unsure",
          reviewed_by: "box-session-failsafe",
          failsafe_reason: args.reason,
          job_id: args.jobId,
        },
      });
    } catch (e) {
      console.warn(`[deploy-guardian] failsafe activity write failed for ${watch.id}:`, e instanceof Error ? e.message : e);
    }
    console.log(`[deploy-guardian] ${watch.branch} → FAIL-SAFE: verdict='unsure', escalated (job ${args.jobId.slice(0, 8)} — ${args.reason})`);
    return { stamped: true, escalated };
  } catch (e) {
    console.error("[deploy-guardian] failsafeStampWatchUnsure threw:", e instanceof Error ? e.message : e);
    return { stamped: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
