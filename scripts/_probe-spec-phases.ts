import { readFileSync } from "fs";
import { resolve } from "path";

async function main() {
  const envPath = resolve(__dirname, "../.env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const slugToCheck = "a-fraud-ban-must-not-manufacture-a-ticket-arguing-to-reverse-it";

  const { data: specs } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", slugToCheck);

  console.log("Spec:", specs);

  if (specs && specs.length > 0) {
    const specId = specs[0].id;

    const { data: phases } = await admin
      .from("spec_phases")
      .select("phase, status")
      .eq("spec_id", specId)
      .order("phase", { ascending: true });

    console.log("Spec phases:", phases);

    if (phases) {
      const allShipped = phases.every(p => p.status === "shipped");
      console.log(`\nDerived shipped status: ${allShipped ? "YES (all phases shipped)" : "NO"}`);
      console.log(`Stored specs.status: ${specs[0].status}`);
    }
  }
}

main().catch(console.error);
