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

  // Get the spec
  const { data: spec } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "cancel-after-renewal-never-escalates")
    .single();

  console.log("Spec:", spec);

  // Get all phases
  const { data: phases } = await admin
    .from("spec_phases")
    .select("phase_number, status, title")
    .eq("spec_id", spec?.id)
    .order("phase_number", { ascending: true });

  console.log("Phases:");
  phases?.forEach(p => console.log(`  Phase ${p.phase_number}: ${p.status} - ${p.title}`));
})();
