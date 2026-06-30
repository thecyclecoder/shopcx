/**
 * One-off BACKFILL: legacy goals shipped their specs ONE-OFF (before the goal-branch/goal-fold machinery),
 * so they have no goal branch to atomically promote and never reached complete→folded — they sit greenlit/
 * proposed at 100% rollup, on the active board forever (the Archive section only renders status='folded').
 *
 * This folds the stuck NON-PARENT, 100%-rollup, no-goal-branch goals → complete → folded so they move to the
 * Archive section. PARENT goals (is_parent OR has child goals) are SKIPPED — a parent stays active awaiting its
 * future sub-goals. SDK-only (setGoalStatus). Their per-spec knowledge already folded into the brain
 * individually; this is the goal-row archive flip (no goal-level brain re-author).
 *
 * DRY-RUN by default; APPLY=1 to write.
 */
import "./_bootstrap";
import { getGoals } from "../src/lib/brain-roadmap";
import { listGoals, setGoalStatus } from "../src/lib/goals-table";
import { goalBranchState } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.env.APPLY === "1";

(async () => {
  const cards = await getGoals(WS);
  const rows = await listGoals(WS, {});
  const rowBySlug = new Map(rows.map((r) => [r.slug, r]));
  const childParentIds = new Set(rows.map((r) => r.parent_goal_id).filter(Boolean) as string[]);

  const fold: { slug: string; stored: string }[] = [];
  for (const c of cards) {
    const row = rowBySlug.get(c.slug)!;
    if (row.status === "folded") continue;
    if (c.pct !== 100) continue;
    // PARENT exclusion: explicit flag OR structural (some goal names it as parent).
    if (row.is_parent || childParentIds.has(row.id)) { console.log(`skip PARENT ${c.slug} (pct=${c.pct})`); continue; }
    // SAFETY: never fold a goal with an unmerged goal branch (a member carries goal_branch_sha) — that path
    // promotes atomically via promoteCompleteGoalsToMain, not this backfill.
    const gbs = await goalBranchState(WS, c.slug);
    const onBranch = gbs.specs.filter((s) => s.onGoalBranch).map((s) => s.slug);
    if (onBranch.length) { console.log(`skip ${c.slug} — has goal-branch members: ${onBranch.join(", ")}`); continue; }
    fold.push({ slug: c.slug, stored: row.status });
  }

  console.log(`\nlegacy goals to fold (${fold.length}):`);
  for (const f of fold) console.log(`  ${f.slug} (stored=${f.stored} → complete → folded)`);

  if (!APPLY) { console.log("\n[DRY-RUN] no writes. Set APPLY=1 to execute."); return; }

  for (const f of fold) {
    const row = rowBySlug.get(f.slug)!;
    if (row.status !== "complete") await setGoalStatus(row.id, "complete", `legacy-fold-backfill:${f.slug}`);
    await setGoalStatus(row.id, "folded", `legacy-fold-backfill:${f.slug}`);
    console.log(`  folded ${f.slug}`);
  }
  console.log("\nDONE.");
})().catch((e) => { console.error(e); process.exit(1); });
