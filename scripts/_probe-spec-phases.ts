async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const specs = [
    "fraud-nightly-scan-shopify-domain-column-fix",
    "popup-offer-normalize-shopify-product-id"
  ];

  console.log("=== Phase Rollup Status ===\n");

  for (const slug of specs) {
    console.log(`\n${slug}:`);

    // Resolve the spec row first — spec_phases is keyed by spec_id, not slug.
    const { data: spec } = await admin
      .from("specs")
      .select("id, status")
      .eq("slug", slug)
      .single();

    if (!spec) {
      console.log(`  Spec not found`);
      continue;
    }

    // Get phases for this spec — order by the current schema column (position).
    const { data: phases } = await admin
      .from("spec_phases")
      .select("position, title, status")
      .eq("spec_id", spec.id)
      .order("position", { ascending: true });

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
