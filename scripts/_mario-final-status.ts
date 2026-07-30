import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/brain-roadmap";

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
  const { data: raw } = await admin
    .from("specs")
    .select("slug, status, vale_pass, vale_review_passed_at")
    .eq("workspace_id", WS)
    .in("slug", SLUGS);
  const rawBySlug = new Map((raw ?? []).map((s: Record<string, unknown>) => [s.slug as string, s]));

  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("spec_slug, kind, status, created_at")
    .eq("workspace_id", WS)
    .in("spec_slug", SLUGS)
    .in("kind", ["build", "spec-test", "fold"])
    .order("created_at", { ascending: false });
  const jobBySlug = new Map<string, string>();
  for (const j of (jobs ?? []) as { spec_slug: string; kind: string; status: string }[]) {
    if (!jobBySlug.has(j.spec_slug)) jobBySlug.set(j.spec_slug, `${j.kind}:${j.status}`);
  }

  for (const slug of SLUGS) {
    const card = await getSpec(WS, slug).then((r) => r?.card).catch(() => null);
    const r = rawBySlug.get(slug) as Record<string, unknown> | undefined;
    const blocked = card?.blockedBy?.filter((b: { cleared: boolean }) => !b.cleared).map((b: { slug: string }) => b.slug) ?? [];
    console.log(`• ${slug}`);
    console.log(`    derived_status=${card?.status ?? "?"}  stored=${r?.status ?? "(null)"}  vale_pass=${r?.vale_pass}`);
    console.log(`    uncleared_blockers=${blocked.length ? blocked.join(", ") : "none"}   build_job=${jobBySlug.get(slug) ?? "—"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
