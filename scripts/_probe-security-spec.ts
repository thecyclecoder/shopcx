import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

async function probe() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  // Check specs table
  console.log("=== Specs table ===");
  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "security-dep-upgrades-2026-10-ea6d0137382a");

  console.log("Specs:", JSON.stringify(specs, null, 2));

  // Check spec_phases for this spec
  if (specs && specs.length > 0) {
    const specId = specs[0].id;
    console.log("\n=== Spec phases for spec_id:", specId, "===");
    const { data: phases } = await admin
      .from("spec_phases")
      .select("spec_id, phase, status")
      .eq("spec_id", specId);

    console.log("Phases:", JSON.stringify(phases, null, 2));
  }
}

probe().catch(console.error);
