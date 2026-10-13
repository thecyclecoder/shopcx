(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  // Check spec status
  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "db-health-detector-measures-current-rate");

  console.log("Spec:", specs?.[0]);

  // Check phases
  if (specs?.[0]) {
    const { data: phases } = await admin
      .from("spec_phases")
      .select("spec_id, phase_number, title, status")
      .eq("spec_id", specs[0].id)
      .order("phase_number");

    console.log("Phases:");
    phases?.forEach((p) => {
      console.log(`  Phase ${p.phase_number} (${p.title}): ${p.status}`);
    });
  }
})();
