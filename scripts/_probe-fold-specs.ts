(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  // Nested embed columns per spec row: spec_phasesposition, title, status — ordered by
  // spec_phases.position so the fold-spec probe reads phase position/title/status from the
  // current schema (the removed `phase` column is no longer requested).
  const { data, error } = await admin
    .from("specs")
    .select(
      `slug, status, spec_phases(position, title, status)`
    )
    .in("slug", [
      "bianca-cold-scaler-campaign-cac-ltv-sensor",
      "bianca-cold-test-recent-purchaser-exclusion",
    ])
    .order("position", { referencedTable: "spec_phases", ascending: true });

  if (error) {
    console.error("Query error:", error);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));

  // Check if all phases are shipped
  for (const spec of data ?? []) {
    const phases = (spec.spec_phases ?? []) as Array<{ position: number; title: string; status: string }>;
    const allShipped = phases.length > 0 && phases.every((p) => p.status === "shipped");
    console.log(
      `\n${spec.slug}:`,
      `stored_status=${spec.status}`,
      `phases=${JSON.stringify(phases)}`,
      `all_phases_shipped=${allShipped}`
    );
  }
})();
