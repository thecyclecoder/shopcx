/** Read-only: which slugs still have a needs_attention job (the Family-1b keep condition)? */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const admin = createAdminClient();
const SLUGS = [
  "ticket-direction-path-workflow-enum-drift",
  "security-dep-watch",
  "1eddd352-ad99-4173-95fa-89b9dff49712",
  "pr-2416",
];

async function main() {
  for (const slug of SLUGS) {
    const { data } = await admin
      .from("agent_jobs")
      .select("id, kind, status, created_at")
      .eq("spec_slug", slug)
      .order("created_at", { ascending: false })
      .limit(6);
    console.log(`\n${slug}:`);
    for (const j of (data ?? []) as Array<{ id: string; kind: string; status: string; created_at: string }>) {
      const ageH = ((Date.now() - new Date(j.created_at).getTime()) / 3_600_000).toFixed(0);
      console.log(`  ${j.id.slice(0, 8)}  ${j.kind.padEnd(18)} ${j.status.padEnd(16)} ${ageH}h`);
    }
    if (!(data ?? []).length) console.log("  (no agent_jobs rows at all)");
  }

  // The two cs-director cards — same ticket or different?
  const { data: cards } = await admin
    .from("dashboard_notifications")
    .select("created_at, metadata")
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(2000);
  console.log("\ncs_director_escalate_founder cards:");
  for (const c of (cards ?? []) as Array<{ created_at: string; metadata: Record<string, unknown> | null }>) {
    const m = c.metadata ?? {};
    if (m["escalation_kind"] !== "cs_director_escalate_founder") continue;
    console.log(`  ticket=${m["ticket_id"]}  raised=${c.created_at}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
