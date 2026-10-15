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

  // Check phase status for the error-feed spec
  const specResult = await admin
    .from("specs")
    .select("id")
    .eq("slug", "error-feed-drop-agent-jobs-id-uuid-like-adhoc-noise");

  const specIds = specResult.data?.map((r: any) => r.id) || [];

  if (specIds.length === 0) {
    console.error("Spec not found");
    process.exit(1);
  }

  const { data, error } = await admin
    .from("spec_phases")
    .select("spec_id, phase_order, phase, status")
    .in("spec_id", specIds)
    .order("phase_order", { ascending: true });

  if (error) {
    console.error("Query error:", error);
    process.exit(1);
  }

  console.log("Phase status for error-feed-drop-agent-jobs-id-uuid-like-adhoc-noise:");
  console.log(JSON.stringify(data, null, 2));

  // Check if all phases are shipped
  const allShipped = data && data.length > 0 && data.every((p: any) => p.status === "shipped");
  console.log("\nAll phases shipped?", allShipped);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
