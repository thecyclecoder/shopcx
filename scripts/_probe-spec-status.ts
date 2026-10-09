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

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const slug = "error-feed-drop-spec-phases-phase-column-adhoc-postgrest-noi";

  const { data: spec, error: specError } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", slug)
    .single();

  if (specError) {
    console.log("Spec query error:", specError);
    process.exit(1);
  }

  console.log("Spec:", spec);

  if (spec) {
    const { data: phases, error: phasesError } = await admin
      .from("spec_phases")
      .select("phase, status")
      .eq("spec_id", spec.id);

    if (phasesError) {
      console.log("Phases query error:", phasesError);
      process.exit(1);
    }

    console.log("Phases:", phases);
  }
})();
