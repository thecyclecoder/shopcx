#!/usr/bin/env npx tsx
/**
 * Extract categories from Gorgias macro names (Cancel::, Refund::, Tracking::, etc.)
 * Run after reimport: npx tsx scripts/categorize-macros.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Map Gorgias name prefixes to categories
const CATEGORY_MAP: Record<string, string> = {
  "cancel": "subscription",
  "refund": "billing",
  "tracking": "shipping",
  "replacement": "shipping",
  "exchange": "shipping",
  "modify requests": "subscription",
  "modify": "subscription",
  "subscription": "subscription",
  "loyalty program": "billing",
  "collaboration": "general",
  "social": "general",
  "meta shop": "product",
  "coffee": "product",
  "superfood tabs": "product",
  "ashwavana": "product",
  "myaccount": "general",
  "1st renewal": "billing",
  "voicemail": "general",
  "sms": "general",
};

async function main() {
  const { data: macros } = await supabase
    .from("macros")
    .select("id, name")
    .eq("workspace_id", WORKSPACE_ID);

  if (!macros?.length) { console.log("No macros found"); return; }

  let categorized = 0;
  for (const m of macros) {
    const nameLower = m.name.toLowerCase().trim();

    let category: string | null = null;
    for (const [prefix, cat] of Object.entries(CATEGORY_MAP)) {
      if (nameLower.startsWith(prefix) || nameLower.includes(`::${prefix}`)) {
        category = cat;
        break;
      }
    }

    if (!category) {
      // Infer from keywords
      if (nameLower.includes("cancel")) category = "subscription";
      else if (nameLower.includes("refund") || nameLower.includes("charge") || nameLower.includes("payment")) category = "billing";
      else if (nameLower.includes("track") || nameLower.includes("ship") || nameLower.includes("deliver")) category = "shipping";
      else if (nameLower.includes("order")) category = "shipping";
      else if (nameLower.includes("subscri") || nameLower.includes("renewal") || nameLower.includes("pause")) category = "subscription";
      else category = "general";
    }

    await supabase.from("macros").update({ category }).eq("id", m.id);
    categorized++;
  }

  console.log(`Categorized ${categorized} macros`);

  // Show distribution
  const { data: dist } = await supabase
    .from("macros")
    .select("category")
    .eq("workspace_id", WORKSPACE_ID);

  const counts: Record<string, number> = {};
  for (const m of dist || []) {
    counts[m.category || "null"] = (counts[m.category || "null"] || 0) + 1;
  }
  console.log("\nCategory distribution:");
  for (const [cat, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
}

main().catch(console.error);
