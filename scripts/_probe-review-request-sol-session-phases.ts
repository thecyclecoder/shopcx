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

  // Get spec ID
  const { data: specData } = await admin.from("specs").select("id").eq("slug", "review-request-sol-session").single();
  if (!specData?.id) {
    console.error("Spec not found");
    process.exit(1);
  }

  // Check all phases for review-request-sol-session
  const { data, error } = await admin
    .from("spec_phases")
    .select("id, spec_id, phase_name, status")
    .eq("spec_id", specData.id)
    .order("phase_order", { ascending: true });

  if (error) {
    console.error("Error:", error);
    process.exit(1);
  }

  console.log("Spec phases for review-request-sol-session:");
  if (data && data.length > 0) {
    for (const phase of data) {
      console.log(`  Phase: ${phase.phase_name} → Status: ${phase.status}`);
    }
    const allShipped = data.every(p => p.status === "shipped");
    console.log(`\nAll phases shipped: ${allShipped}`);
  } else {
    console.log("No phases found");
  }
})();
