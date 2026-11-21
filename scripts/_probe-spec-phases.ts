// Environment variables should already be set in the execution environment

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: specs, error: specError } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "error-feed-drop-spec-phase-checks-check-type-direct-rest-noi");

  if (specError) {
    console.error("Error fetching spec:", specError);
    process.exit(1);
  }

  if (!specs || specs.length === 0) {
    console.error("Spec not found");
    process.exit(1);
  }

  const spec = specs[0];
  console.log("Spec found:", {
    id: spec.id,
    slug: spec.slug,
    stored_status: spec.status,
  });

  const { data: phases, error: phaseError } = await admin
    .from("spec_phases")
    .select("phase, status")
    .eq("spec_id", spec.id)
    .order("phase", { ascending: true });

  if (phaseError) {
    console.error("Error fetching phases:", phaseError);
    process.exit(1);
  }

  console.log("\nPhases:");
  if (!phases || phases.length === 0) {
    console.log("  (no phases found)");
  } else {
    for (const phase of phases) {
      console.log(`  Phase ${phase.phase}: ${phase.status}`);
    }
    const allShipped = phases.every((p) => p.status === "shipped");
    console.log(
      `\nAll phases shipped: ${allShipped ? "YES (spec is foldable)" : "NO"}`
    );
  }
})();
