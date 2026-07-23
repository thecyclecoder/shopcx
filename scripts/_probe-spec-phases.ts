import { readFileSync } from "fs";
import { resolve } from "path";

(async () => {
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

  // Check the spec and its phases
  const specSlug = "build-lane-requeue-on-expired-oauth-401-instead-of-terminal-fail";

  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, status, created_at")
    .eq("slug", specSlug)
    .limit(1);

  console.log("Spec:", specs);

  if (specs && specs.length > 0) {
    const specId = specs[0].id;

    const { data: phases } = await admin
      .from("spec_phases")
      .select("phase, status, completed_at")
      .eq("spec_id", specId)
      .order("phase", { ascending: true });

    console.log("\nPhases for", specSlug);
    console.log(phases);

    // Check if all phases are shipped
    const allShipped = phases?.every(p => p.status === "shipped");
    console.log("\nAll phases shipped?", allShipped);
  }
})();
