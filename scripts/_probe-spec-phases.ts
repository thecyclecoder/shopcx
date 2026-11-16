async function probe() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "error-feed-drop-goal-milestones-status-column-adhoc-noise");

  if (!specs || specs.length === 0) {
    console.log("Spec not found");
    process.exit(1);
  }

  const specId = specs[0].id;
  console.log(`Spec ID: ${specId}, Status column: ${specs[0].status}`);

  const { data: phases } = await admin
    .from("spec_phases")
    .select("phase_num, phase_name, status")
    .eq("spec_id", specId)
    .order("phase_num");

  console.log("Phase statuses:");
  if (phases) {
    for (const p of phases) {
      console.log(`  Phase ${p.phase_num} (${p.phase_name}): ${p.status}`);
    }
    const allShipped = phases.every(p => p.status === "shipped");
    console.log(`All phases shipped: ${allShipped}`);
  }
}

probe();
