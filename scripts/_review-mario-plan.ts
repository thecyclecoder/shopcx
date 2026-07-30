import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getGoal } from "../src/lib/goals-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const g = await getGoal(WS, "mario-pipeline-plumbing");
  if (!g) { console.log("goal not found"); return; }
  const mById = new Map(g.milestones.map((m) => [m.id, m]));

  // Specs attached to this goal's milestones
  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, title, status, owner, parent_kind, milestone_id, blocked_by, vale_pass, auto_build, created_at")
    .eq("workspace_id", WS)
    .in("milestone_id", g.milestones.map((m) => m.id))
    .order("created_at", { ascending: true });

  console.log(`\n=== SPECS under goal mario-pipeline-plumbing (${specs?.length ?? 0}) ===`);
  for (const s of specs ?? []) {
    const m = s.milestone_id ? mById.get(s.milestone_id) : null;
    console.log(`\n• ${s.slug}`);
    console.log(`  title:      ${s.title}`);
    console.log(`  status:     ${s.status ?? "(derived)"}   vale_pass=${s.vale_pass}   auto_build=${s.auto_build}`);
    console.log(`  owner:      ${s.owner}   parent_kind=${s.parent_kind}   milestone=${m ? m.position + " " + m.title : s.milestone_id}`);
    console.log(`  blocked_by: ${JSON.stringify(s.blocked_by)}`);
  }

  // Any plan / pending-approval jobs for this goal
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, kind, status, spec_slug, created_at, needs_attention_class")
    .eq("workspace_id", WS)
    .in("status", ["needs_approval", "needs_input", "queued_resume", "queued", "building"])
    .order("created_at", { ascending: false })
    .limit(30);
  console.log(`\n=== OPEN agent_jobs (approval/plan-relevant) ===`);
  for (const j of jobs ?? []) {
    console.log(`  [${j.status}] kind=${j.kind} slug=${j.spec_slug} id=${j.id.slice(0,8)} class=${j.needs_attention_class ?? ""}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
