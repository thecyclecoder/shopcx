import { readFileSync } from "fs";
import { resolve } from "path";

(async () => {
  // Try to load env from the main shopcx repo
  const mainEnvPath = resolve(__dirname, "../../shopcx/.env.local");
  try {
    for (const line of readFileSync(mainEnvPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq);
      if (!process.env[k]) process.env[k] = t.slice(eq + 1);
    }
  } catch {
    // Env might already be set in the environment
  }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: specPhases, error } = await admin
    .from("spec_phases")
    .select("phase_number, title, status")
    .eq("spec_slug", "error-feed-drop-spec-card-state-spec-id-adhoc-rest-noise");

  if (error) {
    console.error("Error querying spec_phases:", error);
    process.exit(1);
  }

  console.log("Spec phases for error-feed-drop-spec-card-state-spec-id-adhoc-rest-noise:");
  console.log(JSON.stringify(specPhases, null, 2));

  const allShipped = specPhases?.every((p) => p.status === "shipped");
  console.log(`\nAll phases shipped: ${allShipped}`);

  if (specPhases && specPhases.length > 0) {
    const statuses = [...new Set(specPhases.map((p) => p.status))];
    console.log(`Unique statuses: ${statuses.join(", ")}`);
  }
})();

