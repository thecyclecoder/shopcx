/**
 * Greenlights the director-chats-in-message-center goal (CEO directive) and
 * enqueues a kind='plan' agent_jobs row so Pia decomposes it into a
 * milestone->spec tree for review. Mirrors POST /api/roadmap/plan.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { greenlightGoal } from "../src/lib/goals-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GOAL_SLUG = "director-chats-in-message-center";

async function main() {
  const gl = await greenlightGoal(WORKSPACE_ID, GOAL_SLUG, "ceo:dylan");
  console.log("greenlit:", JSON.stringify(gl));

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: WORKSPACE_ID,
      spec_slug: GOAL_SLUG,
      kind: "plan",
      status: "queued",
      instructions: null,
      created_by: null,
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log("plan job enqueued:", data.id);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
