/**
 * Seed Superfoods Co's competitor deny-list. When Pass-1 sees a
 * commenter positively promote one of these on our ads, the comment
 * gets deleted and the user gets banned automatically. List is
 * editable per workspace via workspaces.social_competitor_keywords.
 *
 * Agents can grow the list inline via the "Flag as competitor
 * promotion" button on the social-comment detail page.
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

// Curated by category. Direct competitors first, then adjacent.
const COMPETITORS = `Ryze
Ryze mushroom coffee
Mud\\Wtr
MudWtr
MUD/WTR
Four Sigmatic
Laird Superfood
Bulletproof
Athletic Greens
AG1
Bloom Nutrition
Bloom Greens
Olipop
Poppi
Magic Mind
Liquid IV
Beam
Care/of
Ritual
Seed
Goli
Olly
Onnit
Huel
Soylent
Kachava`;

async function main() {
  const { error } = await sb.from("workspaces")
    .update({ social_competitor_keywords: COMPETITORS })
    .eq("id", WS);
  if (error) throw error;
  console.log("✓ seeded Superfoods Co competitor deny-list:");
  console.log(COMPETITORS);
}
main().catch(e => { console.error(e); process.exit(1); });
