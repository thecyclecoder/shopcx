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

const main = async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: spec, error: specError } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "max-critique-reaches-dahlia-and-the-box-card-shows-one-face")
    .single();

  if (specError) {
    console.log("Error fetching spec:", specError);
    process.exit(1);
  }

  console.log("Spec:", JSON.stringify(spec, null, 2));

  const { data: phases, error: phasesError } = await admin
    .from("spec_phases")
    .select("phase, status")
    .eq("spec_id", spec.id)
    .order("phase", { ascending: true });

  if (phasesError) {
    console.log("Error fetching phases:", phasesError);
    process.exit(1);
  }

  console.log("Phases:", JSON.stringify(phases, null, 2));

  // Check if all phases are shipped
  const allShipped =
    phases && phases.length > 0 && phases.every((p) => p.status === "shipped");
  console.log(`All phases shipped: ${allShipped}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
