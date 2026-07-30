import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const admin = createAdminClient();
  const { data: job } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("id", "eb1c7e4b-0000-0000-0000-000000000000".slice(0, 0) ? "" : "eb1c7e4b")
    .maybeSingle();
  // the .eq above needs the full id — refetch by prefix instead
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, kind, status, spec_slug, instructions, pending_actions, questions, log_tail, session_note")
    .eq("kind", "plan")
    .eq("spec_slug", "mario-pipeline-plumbing")
    .order("created_at", { ascending: false })
    .limit(1);
  const j = jobs?.[0];
  if (!j) { console.log("plan job not found"); return; }
  console.log("JOB", j.id, j.status);
  console.log("\n--- session_note ---\n", j.session_note ?? "(none)");
  console.log("\n--- pending_actions ---\n", JSON.stringify(j.pending_actions, null, 2));
  console.log("\n--- questions ---\n", JSON.stringify(j.questions, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
