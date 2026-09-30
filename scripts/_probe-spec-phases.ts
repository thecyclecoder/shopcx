import { loadEnv } from "./_bootstrap"; 
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

(async () => {
  const admin = createAdminClient();

  const { data } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "a-green-loop-must-not-hide-a-stale-output-table")
    .limit(1);

  if (!data || data.length === 0) {
    console.log("Spec not found");
    process.exit(1);
  }

  const specId = data[0].id;
  const specStatus = data[0].status;

  console.log(`Spec: ${data[0].slug}`);
  console.log(`Stored status: ${specStatus}`);

  const { data: phases } = await admin
    .from("spec_phases")
    .select("phase_number, status")
    .eq("spec_id", specId)
    .order("phase_number");

  console.log("\nPhases:");
  phases?.forEach((p) => {
    console.log(`  Phase ${p.phase_number}: ${p.status}`);
  });

  const allShipped = phases?.every((p) => p.status === "shipped");
  console.log(`\nAll phases shipped: ${allShipped}`);
  
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
