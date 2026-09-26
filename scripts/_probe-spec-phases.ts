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

    // Get phases for this spec
    const { data: phases } = await admin
      .from("spec_phases")
      .select("phase_title, status")
      .eq("spec_slug", slug)
      .order("phase_number", { ascending: true });

    if (phases && phases.length > 0) {
      phases.forEach(p => {
        console.log(`  - ${p.phase_title}: ${p.status}`);
      });

      // Check if all shipped
      const allShipped = phases.every(p => p.status === "shipped");
      console.log(`  → Derived shipped state: ${allShipped ? "YES (all phases shipped)" : "NO"}`);
    } else {
      console.log(`  No phases found`);
    }

    // Check stored status in specs table
    const { data: spec } = await admin
      .from("specs")
      .select("status")
      .eq("slug", slug)
      .single();

    if (spec) {
      console.log(`  → Stored specs.status: ${spec.status}`);
    }
  }
}

main();
