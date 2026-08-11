async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  // Check the spec phases for reconcile-migration-drift-2026-08-superseded-and-check-superset
  const { data: phases } = await admin
    .from("spec_phases")
    .select("id, phase_order, phase_name, status, created_at, updated_at")
    .eq("spec_slug", "reconcile-migration-drift-2026-08-superseded-and-check-superset")
    .order("phase_order", { ascending: true });

  console.log("Spec phases for reconcile-migration-drift-2026-08-superseded-and-check-superset:");
  if (!phases || phases.length === 0) {
    console.log("  NO PHASES FOUND");
  } else {
    phases.forEach((p: any) => {
      console.log(`  Phase ${p.phase_order}: ${p.phase_name} → status=${p.status}`);
    });
    const allShipped = phases.every((p: any) => p.status === "shipped");
    console.log(`\nDerived shipped status (all phases shipped): ${allShipped}`);
  }

  // Also check the spec row itself for reference
  const { data: spec } = await admin
    .from("specs")
    .select("slug, status, created_at, updated_at")
    .eq("slug", "reconcile-migration-drift-2026-08-superseded-and-check-superset")
    .single();

  if (spec) {
    console.log(`\nSpec row status (stored column): ${spec.status}`);
  }
}

main().catch(console.error);
