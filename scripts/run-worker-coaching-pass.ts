// run-worker-coaching-pass — the DevOps Director's standing worker-coaching pass (worker-coaching-loop
// Phase 1). Detects each worker's repeated mistakes from director_activity, then coaches (amends the
// worker's instruction set + logs the message + posts the #directors board), routes a real code bug to
// Repair, or escalates to the CEO after N failed coachings — and re-checks that past coachings stuck.
//
// TWO-PHASE (dry-run by default, like the audit/backfill scripts):
//   npx tsx scripts/run-worker-coaching-pass.ts                 # dry-run — print the plan, no writes
//   npx tsx scripts/run-worker-coaching-pass.ts --apply         # write coachings/routes/escalations
//   npx tsx scripts/run-worker-coaching-pass.ts --apply --coach-all   # coach frequency-only candidates too
//
// Until the Platform/DevOps Director box lane runs this on its standing cadence (director-loop-grading
// M5), an owner/cron runs it. The same library (src/lib/agents/worker-coaching.ts) is what the live
// director calls.
import { createAdminClient } from "./_bootstrap";
import { runWorkerCoachingPass } from "../src/lib/agents/worker-coaching";

async function main() {
  const apply = process.argv.includes("--apply");
  const coachAll = process.argv.includes("--coach-all");
  const admin = createAdminClient();

  const { data: workspaces } = await admin.from("workspaces").select("id, name").order("created_at", { ascending: true });
  if (!workspaces?.length) {
    console.log("no workspaces — nothing to do");
    return;
  }

  console.log(`worker-coaching pass — ${apply ? "APPLY" : "DRY-RUN"}${coachAll ? " (coach-all)" : ""}\n`);
  for (const ws of workspaces as { id: string; name: string | null }[]) {
    const res = await runWorkerCoachingPass(admin, ws.id, { apply, coachAll });
    if (!res.candidates && !res.rechecked.length) continue;
    console.log(`workspace ${ws.name ?? ws.id} — ${res.candidates} candidate(s):`);
    for (const o of res.outcomes) console.log(`  • [${o.action}] ${o.workerKind}/${o.errorClass} — ${o.detail}`);
    for (const r of res.rechecked) console.log(`  • [recheck:${r.status}] coaching ${r.coachingId}`);
    console.log("");
  }
  console.log(apply ? "done (writes applied)" : "done (dry-run — re-run with --apply to write)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
