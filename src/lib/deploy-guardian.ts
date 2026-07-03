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
  if (isMonthlyKpiDriftLoop(loopId)) {
    return "monthly-cadence kpi_drift — trailing 30-day aggregate, not deploy-attributable inside a canary window";
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

export type DeployVerdict = "healthy" | "regressed" | "unsure";

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

/**
 * The verdict rule. `regressed` = a clear deploy-correlated spike (a new red loop, OR a clear new-error
 * spike). `healthy` = nothing new attributable to the deploy. `unsure` = some new signal that doesn't
 * clearly clear the spike bar (escalate, never auto-act — Phase 2 owns escalation).
 */
export function verdictFor(f: DeployWatchFindings): DeployVerdict {
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
 * Evaluate ONE watch: gather findings → verdict → CLAIM the row (atomic, idempotent) → ACT (Phase 2).
 * Only the evaluator that wins the `pending → verdict` claim acts, so a concurrent re-run never double-reverts.
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

  // CLAIM the watch: stamp the verdict where it's still `pending`, returning the row. If we don't get it
  // back, a concurrent evaluator already stamped + acted — do nothing (the idempotency spine for the revert).
  const { data: claimed } = await admin
    .from("deploy_watches")
    .update({ verdict, evaluated_at: new Date().toISOString(), findings: findingsJson })
    .eq("id", watch.id)
    .eq("verdict", "pending")
    .select("id");
  if (!claimed || claimed.length === 0) {
    console.log(`[deploy-guardian] ${watch.branch} → ${verdict} (already claimed by a concurrent tick — no action)`);
    return verdict;
  }

  if (verdict === "healthy") {
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_healthy",
      specSlug: watch.slug,
      reason: `Deploy of ${watch.slug} (${watch.branch}) clean over the ${Math.round(CANARY_WINDOW_MS / 60000)}m canary window — no new deploy-correlated error or red loop.`,
      metadata: deployActivityMeta(watch, verdict, findings),
    });
    console.log(`[deploy-guardian] ${watch.branch} → healthy`);
    return verdict;
  }

  if (verdict === "unsure") {
    // Ambiguous — escalate, never auto-act (the conservative leash). Record the verdict surface too.
    const diagnosis = `Deploy of "${watch.slug}" (${watch.branch}) shows an AMBIGUOUS post-deploy signal (${findings.newErrorSignatures.length} new low-count error signature(s)) that doesn't clearly clear the regression bar. Reva won't auto-revert on an unsure signal — please eyeball it: ${describeRegression(findings)}.`;
    await safeEscalate(admin, watch, { title: `Ambiguous post-deploy signal: ${watch.slug}`, diagnosis, dedupeKey: `deploy-unsure:${watch.id}`, escalationKind: "deploy_unsure" });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_unsure",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: deployActivityMeta(watch, verdict, findings),
    });
    console.log(`[deploy-guardian] ${watch.branch} → unsure (escalated, no revert)`);
    return verdict;
  }

  // verdict === "regressed":
  // spec-goal-branch-pm-flow M5 — an ATOMIC goal→main watch NEVER auto-reverts. The deploy carries a whole
  // goal's many specs in one merge, and the regression bar (verdictFor) is tuned for tiny per-phase diffs, so
  // a single tripped threshold would roll back many specs' tested work. Escalate to the CEO with the diagnosis
  // + the regression detail and let a human decide the rollback (revert the goal merge, hotfix-forward, or
  // accept). The per-spec path keeps auto-revert (cheap + safe for a small diff).
  if (watch.is_atomic) {
    const diagnosis = `ATOMIC goal promotion "${watch.slug}" (${watch.branch}) shows a post-deploy REGRESSION over the ${Math.round(CANARY_WINDOW_MS / 60000)}m canary window: ${describeRegression(findings)}. This deploy landed a whole goal (many specs) on main in one merge — Reva will NOT auto-revert a goal-sized deploy (the regression bar is tuned for small per-phase diffs; reverting the whole goal would discard many specs' tested work). Please decide: revert the goal merge, hotfix-forward, or accept.`;
    await safeEscalate(admin, watch, {
      title: `Regression on atomic goal promotion: ${watch.slug} — manual rollback decision needed`,
      diagnosis,
      dedupeKey: `deploy-atomic-regressed:${watch.id}`,
      escalationKind: "deploy_atomic_regressed",
      metadata: deployActivityMeta(watch, verdict, findings, { atomic: true }),
    });
    await recordDirectorActivity(admin, {
      workspaceId: watch.workspace_id,
      directorFunction: GUARDIAN_FUNCTION,
      actionKind: "deploy_atomic_regressed",
      specSlug: watch.slug,
      reason: diagnosis,
      metadata: deployActivityMeta(watch, verdict, findings, { atomic: true }),
    });
    console.log(`[deploy-guardian] ${watch.branch} → ATOMIC regressed (escalated, NO auto-revert of a whole goal)`);
    return verdict;
  }
  // Per-spec path → Phase 2: restore known-good + escalate.
  await actOnRegression(admin, watch, findings, findingsJson);
  return verdict;
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
