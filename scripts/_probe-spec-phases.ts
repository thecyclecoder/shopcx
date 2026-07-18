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

  const { data: phases, error } = await admin
    .from("spec_phases")
    .select("phase_name, phase_status")
    .eq("spec_slug", "dahlia-author-verdict-requires-variations-no-silent-broadcast-fallback");

  if (error) {
    console.error("Error:", error);
    process.exit(1);
  }

  console.log("Spec: dahlia-author-verdict-requires-variations-no-silent-broadcast-fallback");
  console.log("Phases:");
  if (phases && phases.length > 0) {
    phases.forEach(p => {
      console.log(`  ${p.phase_name}: ${p.phase_status}`);
    });
    const allShipped = phases.every(p => p.phase_status === 'shipped');
    console.log(`\nAll phases shipped: ${allShipped}`);
  } else {
    console.log("  No phases found");
  }
})();
