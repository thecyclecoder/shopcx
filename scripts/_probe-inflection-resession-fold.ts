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

async function probe() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const slug = "inflection-resession-cs-director-ticket-messages-workspace-s";

  // Get spec and its phases
  const { data: spec } = await admin
    .from("specs")
    .select("id, slug, title, status")
    .eq("slug", slug)
    .single();

  console.log("Spec:", spec);

  if (spec) {
    const { data: phases } = await admin
      .from("spec_phases")
      .select("id, number, name, status")
      .eq("spec_id", spec.id)
      .order("number", { ascending: true });

    console.log("Phases:");
    phases?.forEach((p) => {
      console.log(`  Phase ${p.number} (${p.name}): ${p.status}`);
    });

    const allShipped = phases?.every((p) => p.status === "shipped");
    console.log("\nAll phases shipped:", allShipped);
  }
}

probe().catch(console.error);
