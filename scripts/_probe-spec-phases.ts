// Bind lookups to a workspace: createAdminClient bypasses RLS, and spec slugs
// are unique per workspace (not globally), so an unscoped `.eq('slug', ...)`
// can silently return the wrong workspace's row. Fail closed on any Supabase
// error rather than continuing with null data.
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const specs = [
    "fraud-nightly-scan-shopify-domain-column-fix",
    "popup-offer-normalize-shopify-product-id"
  ];

  console.log(`=== Phase Rollup Status (workspace=${WS}) ===\n`);

  for (const slug of specs) {
    console.log(`\n${slug}:`);

    // Resolve the spec row scoped to (workspace_id, slug) — spec_phases is
    // keyed by spec_id, and slug alone is not workspace-unique.
    const { data: spec, error: specErr } = await admin
      .from("specs")
      .select("id, status")
      .eq("workspace_id", WS)
      .eq("slug", slug)
      .maybeSingle();

    if (specErr) {
      throw new Error(`specs lookup failed for slug=${slug}: ${specErr.message}`);
    }
    if (!spec) {
      console.log(`  Spec not found in workspace ${WS}`);
      continue;
    }

    // Get phases for this spec — order by the current schema column (position).
    const { data: phases, error: phasesErr } = await admin
      .from("spec_phases")
      .select("position, title, status")
      .eq("spec_id", spec.id)
      .order("position", { ascending: true });

    if (phasesErr) {
      throw new Error(`spec_phases lookup failed for spec_id=${spec.id}: ${phasesErr.message}`);
    }

    if (phases && phases.length > 0) {
      phases.forEach(p => {
        console.log(`  - ${p.title}: ${p.status}`);
      });

      // Check if all shipped
      const allShipped = phases.every(p => p.status === "shipped");
      console.log(`  → Derived shipped state: ${allShipped ? "YES (all phases shipped)" : "NO"}`);
    } else {
      console.log(`  No phases found`);
    }

    console.log(`  → Stored specs.status: ${spec.status}`);
  }
}

main();
