/**
 * Why did the fix-spec never land in public.specs?
 *
 * The parked card says: "build 7f9da1ef parked spec_row_missing on
 * [[media-buyer-replenish-sanitizes-legacy-advantage-age-targeting]] — the fix spec never landed in
 * public.specs; author lane silently failed upstream".
 *
 * A build parked on a missing row is the SYMPTOM. The defect is an author lane that returned
 * success (or returned nothing) without persisting — the same class as every silent stall today.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG_LIKE = "%advantage%age%";
const BUILD = "7f9da1ef";

async function main() {
  const admin = createAdminClient();

  // 1. Does any spec row exist for it, under any status?
  const { data: specs, error: se } = await admin.from("specs")
    .select("id,slug,status,owner,created_at").eq("workspace_id", WS).ilike("slug", SLUG_LIKE);
  console.log(`=== specs matching "${SLUG_LIKE}": ${se ? "ERROR " + se.message : (specs ?? []).length} ===`);
  for (const s of specs ?? []) console.log(`  ${s.slug} [${s.status}] owner=${s.owner} ${String(s.created_at).slice(0, 16)}`);

  // 2. Every job that touched that slug — the author job and the build that parked.
  const { data: jobs } = await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,created_at,updated_at,log_tail,instructions")
    .eq("workspace_id", WS).ilike("spec_slug", SLUG_LIKE)
    .order("created_at", { ascending: true });
  console.log(`\n=== agent_jobs on that slug: ${(jobs ?? []).length} ===`);
  for (const j of jobs ?? []) {
    console.log(`\n  ${String(j.created_at).slice(0, 16)}  ${String(j.kind).padEnd(18)} [${j.status}]  ${String(j.id).slice(0, 8)}`);
    if (j.instructions) console.log(`     instructions: ${String(j.instructions).slice(0, 240)}`);
    if (j.log_tail) console.log(`     log tail: ${String(j.log_tail).slice(-1200)}`);
  }

  // 3. The parked build itself. agent_jobs.id is UUID; Postgres has no
  //    pattern-match operator for uuid (spec:
  //    no-sql-pattern-match-on-a-uuid-column — the SILENT `.ilike` variant
  //    that was here returned zero rows with no error, reading exactly like
  //    "the build doesn't exist"). Scope by workspace at the DB and narrow
  //    by id-prefix in memory.
  const { data: allJobs } = await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,created_at,log_tail").eq("workspace_id", WS)
    .order("created_at", { ascending: false }).limit(2000);
  const build = (allJobs ?? []).filter(
    (b) => typeof b.id === "string" && b.id.startsWith(BUILD),
  );
  console.log(`\n=== the parked build ${BUILD} ===`);
  for (const b of build) {
    console.log(`  ${b.kind} [${b.status}] slug=${b.spec_slug}`);
    console.log(`  log tail: ${String(b.log_tail ?? "").slice(-1500)}`);
  }

  // 4. Any repair job carrying this signature.
  const { data: repairs } = await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,created_at,log_tail").eq("workspace_id", WS)
    .eq("kind", "repair").order("created_at", { ascending: false }).limit(12);
  console.log(`\n=== recent repair jobs ===`);
  for (const r of repairs ?? []) {
    const hit = /advantage|age|spec_row_missing/i.test(String(r.log_tail ?? "") + String(r.spec_slug ?? ""));
    if (!hit) continue;
    console.log(`  ${String(r.created_at).slice(0, 16)} [${r.status}] ${r.spec_slug}`);
    console.log(`     ${String(r.log_tail ?? "").slice(-700)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
