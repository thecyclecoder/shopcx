import { readFileSync } from "fs";
import { resolve } from "path";

async function main() {
  const envPath = resolve(__dirname, "../.env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const slug = "error-feed-drop-error-events-column-noise-postgrest-cte-shap";

  // Get spec and its phases
  const { data: specs, error } = await admin
    .from("specs")
    .select("id, slug, status, title, owner")
    .eq("slug", slug);

  if (error) {
    console.error("Error:", error);
    process.exit(1);
  }

  if (!specs || specs.length === 0) {
    console.log(`Spec not found: ${slug}`);
    process.exit(1);
  }

  const spec = specs[0];
  console.log(`Spec: ${spec.slug} (${spec.id})`);
  console.log(`Title: ${spec.title}`);
  console.log(`Status (stored): ${spec.status}`);
  console.log(`Owner: ${spec.owner}`);

  // Get phases
  const { data: phases } = await admin
    .from("spec_phases")
    .select("phase_key, status")
    .eq("spec_id", spec.id);

  console.log("\nPhases:");
  if (phases) {
    phases.forEach(p => {
      console.log(`  ${p.phase_key}: ${p.status}`);
    });

    const allShipped = phases.every(p => p.status === "shipped");
    console.log(`\nDerived shipped? ${allShipped}`);
  }
}

main().catch(console.error);
