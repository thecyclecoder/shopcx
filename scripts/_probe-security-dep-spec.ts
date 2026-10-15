import { readFileSync } from "fs";
import { resolve } from "path";

const run = async () => {
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

  // Check the spec and all its phases
  const { data: spec } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "security-dep-upgrades-2026-10-cc23ebac13b4")
    .single();

  console.log("Spec:", spec);

  if (spec) {
    const { data: phases } = await admin
      .from("spec_phases")
      .select("position, title, phase_state")
      .eq("spec_id", spec.id)
      .order("position", { ascending: true });

    console.log("\nPhases:");
    console.log(JSON.stringify(phases, null, 2));

    // Check if all phases are shipped
    const allShipped = phases?.every((p) => p.phase_state === "shipped");
    console.log("\nAll phases shipped?", allShipped);
  }
};

run();

