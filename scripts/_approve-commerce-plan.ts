/**
 * Approve the 9 spec proposals on the Centralized Commerce SDK plan job
 * (agent_jobs 4f665bcc…, kind=plan, status=needs_approval) — the same effect as
 * the CEO tapping "approve" on each of the 9 in the roadmap inbox. Once all 9
 * are approved the job flips to queued_resume and the box worker authors the
 * specs into public.specs + links them to the milestones.
 *
 * Runs approveRoadmapAction as the workspace owner (assertOwner gate).
 *
 * Run: npx tsx scripts/_approve-commerce-plan.ts        (dry — lists actions + owner)
 *      APPLY=1 npx tsx scripts/_approve-commerce-plan.ts (approves all 9)
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOB = "4f665bcc-7022-4490-98cd-ee5259ccfc5b";
const APPLY = process.env.APPLY === "1";

async function main() {
  const admin = createAdminClient();

  // Owner userId for the assertOwner gate.
  const { data: owners } = await admin
    .from("workspace_members")
    .select("user_id, role, display_name")
    .eq("workspace_id", WS)
    .eq("role", "owner");
  if (!owners?.length) { console.error("no owner found"); process.exit(1); }
  const owner = owners[0] as { user_id: string; display_name: string | null };
  console.log(`Owner: ${owner.display_name ?? owner.user_id} (${owner.user_id})`);

  const { data: job } = await admin
    .from("agent_jobs")
    .select("id, status, pending_actions")
    .eq("id", JOB).eq("workspace_id", WS).single();
  if (!job) { console.error("job not found"); process.exit(1); }
  const actions = ((job as { pending_actions: { id: string; status: string; spec?: { slug?: string } }[] }).pending_actions) || [];
  console.log(`Job status: ${(job as { status: string }).status}  ·  ${actions.length} actions`);
  for (const a of actions) console.log(`   [${a.status}] ${a.id}  ${a.spec?.slug ?? ""}`);

  if (!APPLY) { console.log("\nDRY RUN — set APPLY=1 to approve all 9."); return; }

  const pending = actions.filter((a) => a.status === "pending");
  console.log(`\nApproving ${pending.length} pending action(s)…`);
  let lastJob: unknown = null;
  for (const a of pending) {
    const res = await approveRoadmapAction(WS, owner.user_id, { jobId: JOB, actionId: a.id, decision: "approve" });
    if (!res.ok) { console.error(`  ✗ ${a.spec?.slug ?? a.id}: ${res.error}`); process.exit(1); }
    lastJob = res.job;
    console.log(`  ✓ approved ${a.spec?.slug ?? a.id}`);
  }
  const finalStatus = (lastJob as { status?: string } | null)?.status;
  console.log(`\nJob status now: ${finalStatus}`);
  console.log(finalStatus === "queued_resume"
    ? "→ Box worker will resume the plan job and author the 9 specs."
    : "→ (not queued_resume — some actions may remain)");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
