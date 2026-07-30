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

async function main() {
  const admin = createAdminClient();

  const { data: specs } = await admin
    .from("specs")
    .select("slug, status, vale_pass, vale_review_passed_at, vale_review_summary, updated_at")
    .eq("workspace_id", WS)
    .in("slug", SLUGS);
  console.log("=== SPEC REVIEW STATE ===");
  for (const s of (specs ?? []) as Record<string, unknown>[]) {
    console.log(`\n• ${s.slug}`);
    console.log(`  status=${s.status ?? "(derived)"}  vale_pass=${s.vale_pass}  passed_at=${s.vale_review_passed_at ?? "-"}`);
    if (s.vale_review_summary) console.log(`  summary: ${String(s.vale_review_summary).slice(0, 400)}`);
  }

  const { data: acts } = await admin
    .from("director_activity")
    .select("action_kind, spec_slug, reason, created_at, metadata")
    .eq("workspace_id", WS)
    .in("spec_slug", SLUGS)
    .order("created_at", { ascending: true });
  console.log("\n\n=== director_activity (spec-review disposition) ===");
  for (const a of (acts ?? []) as Record<string, unknown>[]) {
    console.log(`  [${a.action_kind}] ${a.spec_slug} :: ${String(a.reason ?? "").slice(0, 200)}`);
  }

  // spec-review job log tails
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("spec_slug, status, log_tail, result")
    .eq("workspace_id", WS)
    .eq("kind", "spec-review")
    .in("spec_slug", SLUGS)
    .order("created_at", { ascending: false });
  console.log("\n\n=== spec-review job tails ===");
  const seen = new Set<string>();
  for (const j of (jobs ?? []) as Record<string, unknown>[]) {
    const slug = String(j.spec_slug);
    if (seen.has(slug)) continue;
    seen.add(slug);
    console.log(`\n• ${slug} [${j.status}]`);
    const tail = String(j.log_tail ?? "").split("\n").slice(-8).join("\n  ");
    if (tail.trim()) console.log(`  ${tail}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
