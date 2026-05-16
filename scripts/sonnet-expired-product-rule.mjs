import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const TITLE = "Expired / near-expiration product → replacement playbook";
const CONTENT = `When a customer complains that received product has a short, soon, or near expiration date — or that the expiration is much shorter than expected vs. a prior shipment — route to the Replacement Order playbook with intent 'expired_items'.

DETECTION:
- "expiration date of 6/26"
- "expires next month"
- "almost expired"
- "way too short of a shelf life"
- "much shorter than the box I got before"
- Customer explicitly states a near-term expiration date

ACTION: Use playbook with handler_name='Replacement Order' (or trigger_intent='expired_items'). The playbook will identify the order, confirm shipping, and create a free replacement for the affected items.

Do NOT escalate just because the date isn't technically past. A customer complaining about a short shelf life on a product they received is a legitimate replacement case — handle it directly. Don't ask if they want a refund or replacement; default to replacement.

Reasoning for the rule: high-LTV customers are especially likely to notice expiration variance because they're repeat buyers. Asking them to choose between refund/replacement turns a 30-second fix into a multi-turn negotiation.`;

const { data: existing } = await sb.from("sonnet_prompts").select("id").eq("workspace_id", W).eq("title", TITLE).maybeSingle();
if (existing) {
  await sb.from("sonnet_prompts").update({ content: CONTENT, category: "rule", sort_order: 0, enabled: true, updated_at: new Date().toISOString() }).eq("id", existing.id);
  console.log(`Updated rule: ${existing.id}`);
} else {
  const { data, error } = await sb.from("sonnet_prompts").insert({ workspace_id: W, title: TITLE, content: CONTENT, category: "rule", sort_order: 0, enabled: true }).select("id").single();
  if (error) throw error;
  console.log(`Inserted rule: ${data.id}`);
}
