(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("specs")
    .select(
      `slug, status, spec_phases(phase, status)`
    )
    .in("slug", [
      "bianca-cold-scaler-campaign-cac-ltv-sensor",
      "bianca-cold-test-recent-purchaser-exclusion",
    ]);

  if (error) {
    console.error("Query error:", error);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));

  // Check if all phases are shipped
  for (const spec of data ?? []) {
    const phases = (spec.spec_phases ?? []) as Array<{ phase: string; status: string }>;
    const allShipped = phases.length > 0 && phases.every((p) => p.status === "shipped");
    console.log(
      `\n${spec.slug}:`,
      `stored_status=${spec.status}`,
      `phases=${JSON.stringify(phases)}`,
      `all_phases_shipped=${allShipped}`
    );
  }
})();
