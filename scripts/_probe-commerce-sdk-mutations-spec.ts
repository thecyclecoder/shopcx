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

  // Check spec row
  const { data: specData } = await admin
    .from("specs")
    .select("*")
    .eq("slug", "commerce-sdk-mutations-rename-subscription-prefix")
    .single();

  console.log("=== SPEC ROW ===");
  console.log(JSON.stringify(specData, null, 2));

  // Check all phase rows for this spec
  const { data: phaseData } = await admin
    .from("spec_phases")
    .select("*")
    .eq("spec_id", specData?.id);

  console.log("\n=== SPEC_PHASES ===");
  console.log(JSON.stringify(phaseData, null, 2));

  // Phase status summary
  if (phaseData) {
    const statuses = phaseData.map(p => ({ phase: p.phase_number, status: p.status }));
    console.log("\nPhase statuses:", statuses);
    const allShipped = phaseData.every(p => p.status === 'shipped');
    console.log("All phases shipped?", allShipped);
  }
})();
