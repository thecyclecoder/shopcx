import { readFileSync } from "fs";
import { resolve } from "path";

async function main() {
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

  const { data } = await admin
    .from("spec_phases")
    .select("slug, phase, status")
    .eq("slug", "db-health-request-volume-top-callers-use-delta")
    .order("phase");

  console.log("Spec phases for db-health-request-volume-top-callers-use-delta:");
  console.log(JSON.stringify(data, null, 2));

  // Check if all are shipped
  const allShipped = data && data.length > 0 && data.every((row: any) => row.status === "shipped");
  console.log("\nAll phases shipped:", allShipped);
}

main().catch(console.error);
