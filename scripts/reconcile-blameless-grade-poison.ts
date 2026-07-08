/**
 * reconcile-blameless-grade-poison — one-time idempotent reconcile of the 2026-07-08 outage
 * poison. During that outage the Claude CLI's Max-account credentials evicted mid-run, so every
 * worker's next `claude -p` returned "authentication_failed" / "Not logged in" with 0 tokens —
 * the deployed grader (blind to the outage) treated every one as a real 1-2/10 failure and the
 * coach's low-grade window filled with the outage grades, then perpetually re-parked
 * needs_attention on the same ghost coaching every cycle.
 *
 * Phases 1+2 of grader-treats-infra-outage-failures-as-blameless-not-low-grades stop NEW poison
 * from landing (the grader now skips blameless-infra jobs with reason='blameless_infra_failure').
 * This script neutralizes the ALREADY-written low grades from the outage window so the current
 * coach re-park loop clears immediately, without waiting a full rollup window for the outage
 * grades to age out.
 *
 * Neutralization mechanism (see reconcileBlamelessGradePoison in src/lib/agents/agent-grader.ts):
 * a matched row's grade is set to NULL and its reasoning is prefixed with
 *   `[BLAMELESS_INFRA][<sig-key>] originally graded N/10 — <old reasoning>`.
 * The NULL grade is what excludes the row from the coach's low-grade window (`.lt("grade", 7)` +
 * `.not("grade", "is", null)`) and from computeAgentRollup (also `.not("grade", "is", null)`),
 * so no query needs to change. The original grade + reasoning are preserved in the audit prefix,
 * and the marker prefix makes re-runs idempotent (already-marked rows are skipped).
 *
 * Guards (matched read-time preconditions repeated in the UPDATE — the compare-and-set rail):
 *   • workspace_id matches (never a cross-workspace write)
 *   • graded_by !== 'human' (a human override is the CEO's call — never overwritten)
 *   • grade IS NOT NULL AND grade < 7 (only a LOW row that's still in its original 1-10 state)
 *   • reasoning does NOT already carry the marker prefix (idempotent — a re-run is a no-op)
 * And the isBlamelessInfraFailure predicate is what actually authorizes each write — a low grade
 * whose underlying agent_jobs.error/log_tail is NOT a blameless-infra signature stays untouched.
 *
 * Dry-run by default — prints what it WOULD neutralize. Pass --apply to write.
 *
 * If --workspace-id is omitted the script iterates every workspace in the DB and reconciles each
 * in turn (per-workspace failures are logged + accumulated but do NOT abort the sweep). This
 * matches sibling `scripts/reconcile-*.ts` scripts + the CLAUDE.md multi-tenant invariant — the
 * reconcile is safe to run globally because every guard is workspace-scoped in the SDK function.
 *
 *   npx tsx scripts/reconcile-blameless-grade-poison.ts                                     # dry run, all workspaces
 *   npx tsx scripts/reconcile-blameless-grade-poison.ts --apply                             # write, all workspaces
 *   npx tsx scripts/reconcile-blameless-grade-poison.ts --workspace-id <uuid>               # dry run, one workspace
 *   npx tsx scripts/reconcile-blameless-grade-poison.ts --workspace-id <uuid> --apply       # write, one workspace
 *   npx tsx scripts/reconcile-blameless-grade-poison.ts --window-days 14                    # narrower window
 */
import { createAdminClient } from "./_bootstrap";
import { reconcileBlamelessGradePoison, type ReconcileBlamelessResult } from "../src/lib/agents/agent-grader";

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

type Admin = ReturnType<typeof createAdminClient>;

async function listWorkspaceIds(admin: Admin): Promise<string[]> {
  const { data, error } = await admin.from("workspaces").select("id");
  if (error) throw new Error(`workspaces read failed: ${error.message}`);
  return ((data as Array<{ id: string }> | null) ?? []).map((w) => w.id);
}

function printPerWorkspaceLine(
  workspaceId: string,
  windowDays: number,
  apply: boolean,
  res: ReconcileBlamelessResult,
): void {
  console.log(
    `reconcile-blameless-grade-poison ws=${workspaceId} window=${windowDays}d ` +
      `${apply ? "APPLIED" : "DRY RUN"} · considered=${res.considered} matched=${res.matched} applied=${res.applied}`,
  );
  for (const d of res.details) {
    console.log(`  · grade=${d.gradeId} job=${d.agentJobId} kind=${d.agentKind} sig=${d.matchedSignature} old=${d.oldGrade}/10`);
  }
}

async function main() {
  const explicitWorkspaceId = arg("workspace-id");
  const apply = process.argv.includes("--apply");
  const windowDaysRaw = arg("window-days");
  const windowDays = windowDaysRaw ? Math.max(1, Math.floor(Number(windowDaysRaw))) : 30;

  const admin = createAdminClient();
  const workspaceIds = explicitWorkspaceId ? [explicitWorkspaceId] : await listWorkspaceIds(admin);
  if (!workspaceIds.length) {
    console.log("no workspaces to reconcile — nothing to do.");
    return;
  }

  let totalConsidered = 0;
  let totalMatched = 0;
  let totalApplied = 0;
  const failures: Array<{ workspaceId: string; error: string }> = [];
  for (const workspaceId of workspaceIds) {
    try {
      const res = await reconcileBlamelessGradePoison({ workspaceId, admin, apply, windowDays });
      printPerWorkspaceLine(workspaceId, windowDays, apply, res);
      totalConsidered += res.considered;
      totalMatched += res.matched;
      totalApplied += res.applied;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ! ws=${workspaceId} failed: ${msg}`);
      failures.push({ workspaceId, error: msg });
    }
  }

  console.log(
    `\nSUMMARY · workspaces=${workspaceIds.length} ${apply ? "APPLIED" : "DRY RUN"} · ` +
      `considered=${totalConsidered} matched=${totalMatched} applied=${totalApplied} failed=${failures.length}`,
  );
  if (!apply && totalMatched > 0) {
    console.log(`  → re-run with --apply to neutralize the ${totalMatched} matched grade(s).`);
  }
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
