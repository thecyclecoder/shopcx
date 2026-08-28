/** Does the spec think it SHIPPED while main no longer has the code? READ-ONLY. */
import { loadEnv } from "./_bootstrap";
loadEnv();

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS = [
  "immediate-charge-renewal-paths-need-per-subscription-idempotency",
  "closing-a-ticket-must-not-destroy-an-active-escalation",
];

async function main() {
  const { getSpec } = await import("../src/lib/specs-table");
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  for (const slug of SLUGS) {
    const s = (await getSpec(WS, slug)) as Record<string, unknown> | null;
    if (!s) { console.log(`${slug}: NOT FOUND`); continue; }
    console.log(`\n── ${slug}`);
    console.log(`   stored status=${JSON.stringify(s.status)} merged_pr=${s.merged_pr ?? "—"} last_merge_sha=${String(s.last_merge_sha ?? "—").slice(0, 10)} auto_build=${s.auto_build}`);

    const { data: phases } = await admin
      .from("spec_phases").select("position, title, status, merge_sha, pr").eq("spec_id", s.id as string).order("position");
    for (const p of ((phases ?? []) as Array<Record<string, unknown>>)) {
      console.log(`   P${p.position} ${String(p.status).padEnd(10)} pr=${p.pr ?? "—"} sha=${String(p.merge_sha ?? "—").slice(0, 10)} "${String(p.title).slice(0, 46)}"`);
    }
    const allShipped = ((phases ?? []) as Array<Record<string, unknown>>).every((p) => p.status === "shipped");
    console.log(`   rollup → ${allShipped ? "SHIPPED" : "not shipped"}`);
  }

  // Any queued/running build job that would re-land it?
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, kind, status, spec_slug, created_at")
    .in("spec_slug", SLUGS)
    .order("created_at", { ascending: false })
    .limit(10);
  console.log(`\njobs for these specs:`);
  for (const j of ((jobs ?? []) as Array<Record<string, unknown>>)) {
    console.log(`   ${String(j.id).slice(0, 8)} ${String(j.kind).padEnd(8)} ${String(j.status).padEnd(16)} ${String(j.spec_slug).slice(0, 40)} ${String(j.created_at).slice(11, 19)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
