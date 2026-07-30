/**
 * Approves Pia's plan for the dahlia-imitate-then-innovate-copy-engine goal
 * (agent_jobs e3223795…, kind=plan, needs_approval) — the same effect as the CEO
 * tapping "approve" on each of the 14 roadmap-inbox actions. Once all are approved
 * the job flips to queued_resume and the box worker authors the 14 specs to public.specs.
 * Founder-approved 2026-07-15 (hold-for-research then approve full tree).
 * Mirrors scripts/_approve-commerce-plan.ts. Dry by default; APPLY=1 to approve.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOB = "e3223795-070e-477b-b4b7-44a663ac27f7";
const APPLY = process.env.APPLY === "1";

async function main() {
  const admin = createAdminClient();
  const { data: owner } = await admin
    .from("workspace_members").select("user_id, role").eq("workspace_id", WS).eq("role", "owner").single();
  if (!owner) { console.log("no owner"); return; }

  const { data: job } = await admin
    .from("agent_jobs").select("id, status, pending_actions").eq("id", JOB).maybeSingle();
  if (!job) { console.log("job not found"); return; }
  const actions = ((job as any).pending_actions || []) as { id: string; status: string; spec?: { slug?: string } }[];
  console.log(`job ${JOB} status=${(job as any).status} · ${actions.length} actions`);
  for (const a of actions) console.log(`   [${a.status}] ${a.spec?.slug ?? a.id}`);

  if (!APPLY) { console.log("\nDRY RUN — set APPLY=1 to approve all."); return; }

  const pending = actions.filter((a) => a.status === "pending");
  console.log(`\napproving ${pending.length} pending action(s)…`);
  for (const a of pending) {
    const res = await approveRoadmapAction(WS, owner.user_id as string, { jobId: JOB, actionId: a.id, decision: "approve" });
    console.log(`  ${res.ok ? "✓" : "✗"} ${a.spec?.slug ?? a.id}${res.ok ? "" : " — " + (res as any).error}`);
  }
  const { data: after } = await admin.from("agent_jobs").select("status").eq("id", JOB).maybeSingle();
  console.log(`\njob status now: ${(after as any)?.status}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
