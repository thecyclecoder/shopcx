import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  // Resolve the workspace owner (the identity approveRoadmapAction gates on).
  const { data: owner } = await admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", WS)
    .eq("role", "owner")
    .single();
  if (!owner) { console.log("no owner found"); return; }
  const userId = owner.user_id as string;
  console.log("owner user_id:", userId);

  // Load the plan job.
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, status, pending_actions")
    .eq("kind", "plan")
    .eq("spec_slug", "mario-pipeline-plumbing")
    .eq("status", "needs_approval")
    .order("created_at", { ascending: false })
    .limit(1);
  const job = jobs?.[0] as { id: string; status: string; pending_actions: { id: string; status: string; summary?: string }[] } | undefined;
  if (!job) { console.log("no needs_approval plan job for mario-pipeline-plumbing"); return; }

  const pending = (job.pending_actions || []).filter((a) => a.status === "pending");
  console.log(`job ${job.id} — ${pending.length} pending action(s) to approve`);

  for (const a of pending) {
    const res = await approveRoadmapAction(WS, userId, {
      jobId: job.id,
      actionId: a.id,
      decision: "approve",
    });
    console.log(`  approve ${a.id} (${a.summary ?? ""}) → ${res.ok ? "ok status=" + (res.job as { status?: string }).status : "ERR " + res.error}`);
  }

  const { data: after } = await admin.from("agent_jobs").select("status").eq("id", job.id).single();
  console.log("final job status:", (after as { status?: string } | null)?.status);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
