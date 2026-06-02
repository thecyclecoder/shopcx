/**
 * Seed Superfoods Co's brand proof points for the social-comment
 * orchestrator. These get woven into public replies when commenters
 * raise price/affordability objections — the value-building moment
 * happens in public, not hidden.
 *
 * Editable per workspace via the `social_brand_proof_points` column
 * (we'll add a Settings UI for it later — for now, this script).
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const PROOF_POINTS = `- 30-day money-back guarantee — no questions asked, full refund if it doesn't work for you
- 700,000+ customers across the country trust Superfoods Company
- Science-backed, real-food ingredients formulated with nutritionists — not lab synthetics
- 15,000+ 5-star reviews on flagship products
- Subscribe & Save brings the per-day cost down meaningfully (~$1-2/day on subscription pricing)
- Regular bundle deals and seasonal promos for budget-conscious customers (don't promise a specific code)`;

async function main() {
  const { error } = await sb.from("workspaces")
    .update({ social_brand_proof_points: PROOF_POINTS })
    .eq("id", WS);
  if (error) throw error;
  console.log("✓ seeded Superfoods Co brand proof points");
  console.log("\n--- preview ---\n" + PROOF_POINTS);
}
main().catch(e => { console.error(e); process.exit(1); });
