import { readFileSync } from "fs";
import { resolve } from "path";

(async () => {
  const envPath = resolve(__dirname, "../.env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  // First, get the spec ID for this slug
  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "a-subscription-is-never-more-than-one-cycle-behind");

  if (!specs || specs.length === 0) {
    console.log("Spec not found");
    process.exit(1);
  }

  const specId = specs[0].id;
  const specStatus = specs[0].status;
  console.log(`\nSpec: a-subscription-is-never-more-than-one-cycle-behind`);
  console.log(`Spec ID: ${specId}`);
  console.log(`Stored spec.status: ${specStatus}`);

  // Get all phases for this spec
  const { data: phases } = await admin
    .from("spec_phases")
    .select("phase_order, title, status")
    .eq("spec_id", specId)
    .order("phase_order", { ascending: true });

  console.log(`\nPhase rollup:`);
  if (!phases || phases.length === 0) {
    console.log("No phases found");
  } else {
    phases.forEach((p, i) => {
      console.log(`  Phase ${p.phase_order}: ${p.title} → status="${p.status}"`);
    });

    const allShipped = phases.every(p => p.status === "shipped");
    console.log(`\nAll phases shipped? ${allShipped}`);
  }
})();
