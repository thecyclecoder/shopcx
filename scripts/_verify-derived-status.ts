/**
 * Read-only verification for specs-status-override-only: with stored status NULL, the readers still derive
 * the correct board status from the phase rollup, and fold eligibility is unaffected.
 */
import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();
  const ws = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

  // 1. Confirm the stored override column is NULL for the cleaned specs, and no derived states remain.
  const { data } = await admin.from("specs").select("slug, status, deferred").in("slug", ["noop-pipeline-test-4", "noop-pipeline-test-5"]).eq("workspace_id", ws);
  console.log("Stored override column after cleanup:");
  for (const r of (data ?? []) as { slug: string; status: string | null; deferred: boolean }[]) {
    console.log(`  ${r.slug}: status=${r.status === null ? "NULL" : r.status} deferred=${r.deferred}`);
  }

  // 2. Derived status via the real reader path (getSpec → deriveSpecCardStatus).
  const { getSpec } = await import("../src/lib/brain-roadmap");
  for (const slug of ["noop-pipeline-test-4", "noop-pipeline-test-5"]) {
    const got = await getSpec(slug, ws);
    if (!got) { console.log(`  ${slug}: getSpec returned null`); continue; }
    const phaseStatuses = got.card.phases.map((p) => p.status).join(",") || "(no phases)";
    console.log(`  ${slug}: DERIVED status=${got.card.status}  phases=[${phaseStatuses}]`);
  }

  // 3. Fold eligibility unaffected — test-4 should still appear (the fold gate reads the DERIVED status).
  const { getAutoFoldEligibleSlugs } = await import("../src/lib/spec-test-runs");
  const eligible = await getAutoFoldEligibleSlugs(ws);
  console.log(`\nAuto-fold-eligible slugs (${eligible.length}):`);
  console.log(`  test-4 fold-eligible: ${eligible.includes("noop-pipeline-test-4")}`);
  console.log(`  test-5 fold-eligible: ${eligible.includes("noop-pipeline-test-5")}`);

  // 4. Full board sweep — confirm zero specs carry a derived stored status now.
  const { data: all } = await admin.from("specs").select("slug, status");
  const DERIVED = new Set(["planned", "in_progress", "shipped"]);
  const leaked = ((all ?? []) as { slug: string; status: string | null }[]).filter((r) => r.status && DERIVED.has(r.status));
  console.log(`\nSpecs still carrying a DERIVED stored status: ${leaked.length}`, leaked.map((r) => r.slug));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
