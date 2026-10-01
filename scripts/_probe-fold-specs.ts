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

  const { data: specs, error } = await admin
    .from("specs")
    .select(`
      id,
      slug,
      status,
      spec_phases(id, status)
    `)
    .in("slug", [
      "error-feed-drop-orders-subtotal-cents-column-adhoc-noise",
      "error-feed-drop-agent-jobs-payload-direct-rest-lookup-noise"
    ]);

  if (error) {
    console.error("Query error:", error);
    process.exit(1);
  }

  console.log("Spec shipping status:");
  for (const spec of specs || []) {
    const phases = spec.spec_phases || [];
    const allShipped = phases.every((p: any) => p.status === "shipped");
    console.log(`\n${spec.slug}:`);
    console.log(`  stored_status: ${spec.status}`);
    console.log(`  total_phases: ${phases.length}`);
    console.log(`  shipped_phases: ${phases.filter((p: any) => p.status === "shipped").length}`);
    console.log(`  derived_status: ${allShipped ? "SHIPPED" : "NOT_SHIPPED"}`);
    if (phases.length > 0) {
      console.log(`  phases:`);
      for (const p of phases) {
        console.log(`    - ${p.id}: ${p.status}`);
      }
    }
  }
})();
