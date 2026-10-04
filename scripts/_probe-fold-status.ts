async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data, error } = await admin.from("specs").select("id, slug, status").eq("slug", "error-feed-drop-daily-amazon-order-snapshots-date-adhoc-nois");
  if (error) { console.error("error fetching spec:", error); process.exit(1); }
  const spec = data?.[0];
  if (!spec) { console.error("spec not found"); process.exit(1); }

  const { data: phases, error: phaseError } = await admin.from("spec_phases").select("phase_num, phase_title, status").eq("spec_id", spec.id).order("phase_num");
  if (phaseError) { console.error("error fetching phases:", phaseError); process.exit(1); }

  console.log("Spec:", spec.slug);
  console.log("Stored status:", spec.status);
  console.log("Phases:");
  phases?.forEach(p => console.log(`  ${p.phase_num}. ${p.phase_title}: ${p.status}`));

  const allShipped = phases?.length && phases.every(p => p.status === "shipped");
  console.log("\nAll phases shipped?", allShipped);
}

main().catch(console.error);
