import { readFileSync } from "fs";
import { resolve } from "path";

async function probe() {
  const envPath = resolve(__dirname, "../.env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("specs")
    .select("id, slug, status")
    .eq("slug", "error-feed-drop-tickets-id-uuid-like-adhoc-noise")
    .single();

  if (error) {
    console.error("Error:", error);
    process.exit(1);
  }

  console.log("Spec:", data.slug, "Status:", data.status);

  const { data: phases } = await admin
    .from("spec_phases")
    .select("phase_order, status")
    .eq("spec_id", data.id)
    .order("phase_order", { ascending: true });

  console.log("Phases:");
  phases?.forEach(p => console.log(`  ${p.phase_order}: ${p.status}`));

  const allShipped = phases?.every(p => p.status === "shipped");
  console.log("All shipped:", allShipped);
}

probe();
