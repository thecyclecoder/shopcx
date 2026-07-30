import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS = [
  "spec-timecard-ledger-and-sdk",
  "spec-timecard-chokepoint-instrumentation",
  "mario-stall-detector-cron-and-thresholds",
  "mario-reactive-box-agent",
  "spec-detail-timecard-timeline",
];

async function snapshot(admin: ReturnType<typeof createAdminClient>) {
  const { data: specs } = await admin
    .from("specs")
    .select("slug, vale_pass, vale_review_passed_at")
    .eq("workspace_id", WS)
    .in("slug", SLUGS);
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("spec_slug, status")
    .eq("workspace_id", WS)
    .eq("kind", "spec-review")
    .in("spec_slug", SLUGS);
  const jobBySlug = new Map<string, string>();
  for (const j of (jobs ?? []) as { spec_slug: string; status: string }[]) jobBySlug.set(j.spec_slug, j.status);
  const bySlug = new Map((specs ?? []).map((s: { slug: string; vale_pass: boolean | null }) => [s.slug, s]));
  return SLUGS.map((slug) => {
    const s = bySlug.get(slug) as { vale_pass: boolean | null } | undefined;
    return { slug, vale_pass: s?.vale_pass ?? null, reviewJob: jobBySlug.get(slug) ?? "(none)" };
  });
}

async function main() {
  const admin = createAdminClient();
  const MAX = 40; // ~ 40 * 20s = ~13 min
  for (let i = 0; i < MAX; i++) {
    const rows = await snapshot(admin);
    const done = rows.every((r) => r.vale_pass !== null);
    const line = rows.map((r) => `${r.vale_pass === true ? "PASS" : r.vale_pass === false ? "FAIL" : "…"}[${r.reviewJob}]`).join("  ");
    console.log(`t+${i * 20}s  ${line}`);
    if (done) {
      console.log("\n=== ALL REVIEWS RESOLVED ===");
      for (const r of rows) console.log(`  ${r.vale_pass ? "✅ PASS" : "❌ FAIL"}  ${r.slug}`);
      process.exit(0);
    }
    await new Promise((res) => setTimeout(res, 20000));
  }
  console.log("timed out waiting for reviews");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
