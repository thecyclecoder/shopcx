/**
 * deploy-guardian — Reva, the Deploy Guardian (docs/brain/specs/deploy-health-rollback-guardian.md).
 *
 * The supervisor on the auto-merge proxy. Auto-merge ([[github-pr-resolve]] `autoMergeReadyPrs`)
 * optimizes "ship the fix"; its degenerate state is shipping a fix that breaks something else and
 * leaving it live. This guardian watches each auto-merged claude/<slug> deploy over a bounded canary
 * window and stamps a verdict — restore-known-good FAST on a clear deploy-correlated regression (Phase
 * 2), escalate anything ambiguous rather than guess.
 *
 * PHASE 1 (this file): WATCH only — no rollback.
 *  - `openDeployWatch` is called from the auto-merge path the moment a build branch squash-merges. It
 *    snapshots the PRE-deploy error/loop baseline and inserts a `pending` row in `deploy_watches` with
 *    a canary window (deployed_at → deployed_at + CANARY_WINDOW_MS).
 *  - `evaluateDueDeployWatches` (driven every minute by [[../inngest/deploy-guardian-cron]]) evaluates
 *    each watch whose window has elapsed: it samples NEW error_events signatures + NEW open loop_alerts
 *    + the live Control-Tower snapshot, attributing only signals that FIRST appear AFTER the deploy
 *    timestamp (the correlation gate, mirroring agent-outage-resilience's outage-correlation tagging),
 *    then stamps healthy | regressed | unsure and writes a director_activity row.
 *
 * Reuses Tao's Control-Tower signals + the error feed — no new monitoring substrate. Best-effort +
 * never throws on the open path (an audit/watch write that crashes the merge it records is worse than
 * the gap — mirrors `recordError` / `recordDirectorActivity`).
 *
 * See [[../tables/deploy_watches]] · [[../tables/error_events]] · [[../tables/loop_alerts]] ·
 * [[control-tower]] · [[director-activity]] · [[../goals/devops-director]].
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { buildControlTowerSnapshot } from "@/lib/control-tower/monitor";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The Platform/DevOps Director supervises the Deploy Guardian — its director_activity rows carry this. */
const GUARDIAN_FUNCTION = "platform";

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

/** Cap the watches evaluated per cron tick so a backlog can't run the tick unbounded. */
const EVAL_BATCH_CAP = 25;

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
 * Open a deploy-watch for a just-auto-merged claude/<slug> deploy. Looks up the branch's build job to
 * resolve the owning workspace + spec slug, snapshots the pre-deploy baseline, and inserts a `pending`
 * watch over the canary window. Idempotent on `merge_sha` (the partial unique index). Best-effort +
 * NEVER throws — a watch that crashes the merge it guards is worse than the gap it closes.
 *
 * Returns the watch id (or null if it no-op'd: no build job for the branch, already opened, table absent).
 */
export async function openDeployWatch(args: {
  admin: Admin;
  branch: string;
  prNumber?: number | null;
  mergeSha?: string | null;
  /** override the deploy timestamp (defaults to now — the squash-merge just happened). */
  deployedAt?: string;
}): Promise<string | null> {
  const { admin, branch } = args;
  try {
    if (!branch || !branch.startsWith("claude/")) return null; // build branches only

    // Resolve the owning workspace + spec slug from the branch's most recent build job (mirrors
    // handleAutoMergedBuildBranch). No build job ⇒ not the director's auto-fix path ⇒ don't watch.
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

    const deployedAt = args.deployedAt || new Date().toISOString();
    const windowEndsAt = new Date(new Date(deployedAt).getTime() + CANARY_WINDOW_MS).toISOString();
    const baseline = await captureBaseline(admin, deployedAt);

    const { data, error } = await admin
      .from("deploy_watches")
      .insert({
        workspace_id: job.workspace_id,
        slug: job.spec_slug || slugFromClaudeBranch(branch),
        branch,
        pr_number: args.prNumber ?? null,
        merge_sha: args.mergeSha ?? null,
        deployed_at: deployedAt,
        window_ends_at: windowEndsAt,
        baseline,
        verdict: "pending",
      })
      .select("id")
      .single();

    if (error) {
      // 23505 = the partial unique index already opened a watch for this merge SHA — fine, not an error.
      if (error.code === "23505") return null;
      console.warn(`[deploy-guardian] openDeployWatch insert failed (${branch}):`, error.message);
      return null;
    }
    console.log(`[deploy-guardian] opened deploy-watch for ${branch} (slug=${job.spec_slug}) → window ${Math.round(CANARY_WINDOW_MS / 60000)}m`);
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
  // and NOT in the pre-deploy baseline. Bounding the upper end to window_ends_at keeps attribution to THIS
  // deploy's window even if the evaluator cron runs late (a later error belongs to a later deploy).
  const { data: errRows } = await admin
    .from("error_events")
    .select("signature, source, title, count, first_seen_at, outage_correlated")
    .gte("first_seen_at", deployedAt)
    .lte("first_seen_at", watch.window_ends_at)
    .eq("outage_correlated", false);
  const newErrorSignatures = ((errRows as Array<{ signature: string; source: string; title: string | null; count: number }> | null) || [])
    .filter((r) => r.signature && !baselineSignatures.has(r.signature))
    .map((r) => ({ signature: r.signature, source: r.source, title: r.title, count: r.count ?? 1 }));

  // NEW red loops: an alert that OPENED after the deploy + isn't one that was already open at deploy time.
  const { data: alertRows } = await admin
    .from("loop_alerts")
    .select("loop_id, reason, detail, opened_at, status")
    .eq("status", "open")
    .gte("opened_at", deployedAt)
    .lte("opened_at", watch.window_ends_at);
  const newRedLoops = ((alertRows as Array<{ loop_id: string; reason: string; detail: string }> | null) || [])
    .filter((r) => r.loop_id && !baselineLoopIds.has(r.loop_id))
    .map((r) => ({ loop_id: r.loop_id, reason: r.reason, detail: r.detail }));

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

  return { newErrorSignatures, newRedLoops, redLoopCount, controlTowerOk };
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

/** Evaluate ONE watch: gather findings → verdict → stamp the row + write a director_activity row. */
export async function evaluateDeployWatch(admin: Admin, watch: DeployWatch): Promise<DeployVerdict> {
  const findings = await gatherDeployFindings(admin, watch);
  const verdict = verdictFor(findings);

  const findingsJson: Record<string, unknown> = {
    newErrorSignatures: findings.newErrorSignatures,
    newRedLoops: findings.newRedLoops,
    redLoopCount: findings.redLoopCount,
    controlTowerOk: findings.controlTowerOk,
  };

  await admin
    .from("deploy_watches")
    .update({ verdict, evaluated_at: new Date().toISOString(), findings: findingsJson })
    .eq("id", watch.id)
    .eq("verdict", "pending"); // idempotent: only the first evaluator stamps it

  const reason =
    verdict === "healthy"
      ? `Deploy of ${watch.slug} (${watch.branch}) clean over the ${Math.round(CANARY_WINDOW_MS / 60000)}m canary window — no new deploy-correlated error or red loop.`
      : verdict === "regressed"
        ? `Deploy of ${watch.slug} (${watch.branch}) introduced a deploy-correlated regression: ${findings.newRedLoops.length} new red loop(s), ${findings.newErrorSignatures.length} new error signature(s).`
        : `Deploy of ${watch.slug} (${watch.branch}) shows an ambiguous post-deploy signal (${findings.newErrorSignatures.length} new low-count error signature(s)) — escalate, do not auto-act.`;

  await recordDirectorActivity(admin, {
    workspaceId: watch.workspace_id,
    directorFunction: GUARDIAN_FUNCTION,
    actionKind: verdict === "healthy" ? "deploy_healthy" : verdict === "regressed" ? "deploy_regressed" : "deploy_unsure",
    specSlug: watch.slug,
    reason,
    metadata: {
      deploy_watch_id: watch.id,
      branch: watch.branch,
      pr_number: watch.pr_number,
      merge_sha: watch.merge_sha,
      verdict,
      new_error_signatures: findings.newErrorSignatures.length,
      new_red_loops: findings.newRedLoops.map((l) => l.loop_id),
      red_loop_count: findings.redLoopCount,
    },
  });

  console.log(`[deploy-guardian] ${watch.branch} → ${verdict} (${findings.newErrorSignatures.length} new sig, ${findings.newRedLoops.length} new red loop)`);
  return verdict;
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
