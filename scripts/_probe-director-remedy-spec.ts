import { readFileSync } from "fs";
import { resolve } from "path";

(async () => {
  const envPath = resolve(__dirname, "../.env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  // Get the spec ID
  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "a-director-remedy-must-be-executable-when-it-can-be")
    .limit(1);

  if (!specs || specs.length === 0) {
    console.log("ERROR: spec not found");
    process.exit(1);
  }

  const specId = specs[0].id;
  console.log(`Found spec: ${specs[0].slug}, stored status: ${specs[0].status}`);

  // Get all phases
  const { data: phases } = await admin
    .from("spec_phases")
    .select("phase, status")
    .eq("spec_id", specId)
    .order("phase", { ascending: true });

  console.log("\nPhases:");
  phases?.forEach((p) => {
    console.log(`  ${p.phase}: ${p.status}`);
  });

  // Check if all are shipped
  const allShipped =
    phases && phases.length > 0 && phases.every((p) => p.status === "shipped");
  console.log(`\nAll phases shipped: ${allShipped}`);
})();
