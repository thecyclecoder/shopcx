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

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const specResult = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "ads-supervisor-fix-fdc11e10-dahlia-bin-f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb")
    .single();

  if (specResult.error) {
    console.log("Spec query error:", specResult.error);
    process.exit(1);
  }

  const spec = specResult.data;
  console.log("Spec:", spec);

  const phasesResult = await admin
    .from("spec_phases")
    .select("id, spec_id, phase_number, status, title")
    .eq("spec_id", spec.id)
    .order("phase_number", { ascending: true });

  if (phasesResult.error) {
    console.log("Phases query error:", phasesResult.error);
    process.exit(1);
  }

  console.log("Phases:", phasesResult.data);
  const allShipped = phasesResult.data?.every((p) => p.status === "shipped") ?? false;
  console.log("All phases shipped?", allShipped);
}

main().catch(console.error);
