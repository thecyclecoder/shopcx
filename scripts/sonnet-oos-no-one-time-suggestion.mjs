/**
 * Insert Sonnet prompt rule: when telling a customer a product is
 * out of stock / on a crisis hold, do NOT suggest a "one-time
 * order" or "check back to grab some sooner" path. The product is
 * not available — there is no faster path than the restock.
 */
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

const TITLE = "OOS / crisis product — never suggest a 'one-time order' or 'check back sooner' path";
const CONTENT = `When you're telling a customer a product is out of stock (crisis hold, awaiting restock, on backorder, etc.), DO NOT in the same message offer a "one-time order" path, suggest "check back sooner," or imply any faster route to getting the product.

There is no faster route. The restock date is the earliest the product is available — by definition. Saying "if you want some sooner as a one-time order, check back July 9" when July 9 IS the restock date is contradictory and reads as filler.

The correct response shape when a product is OOS:
  1. State plainly that it's out of stock (don't apologize unless we caused the OOS).
  2. Give the restock date if known.
  3. If they have an active or paused subscription on the affected variant and auto_readd is on, reassure them their sub is set to auto-switch back when restocked.
  4. Offer ONE alternative path only if available AND meaningful (e.g. a different in-stock flavor as a stopgap). Don't suggest "one-time order" of the OOS product itself.

DO NOT WRITE:
  - "If you'd like to grab some sooner as a one-time order…"
  - "Check back on the website around [restock date]…"
  - "Keep an eye out for it sooner…"
  - "You can place a one-time order once it's back"

These all imply a faster path that doesn't exist, or restate information the previous sentence already gave. They make the response feel padded instead of helpful.

GOLD-STANDARD HANDLING — Michelle case (May 18):
  Customer asked if Mixed Berry was discontinued. Mixed Berry is OOS with restock July 9. Her paused sub is enrolled in the crisis with auto_readd=true.

  WRONG (what happened):
    "It's just temporarily out of stock, and we're expecting it back on July 9, 2026. […] If you'd like to grab some Mixed Berry sooner as a one-time order, I'd suggest checking back on the website around July 9."

  RIGHT:
    "Great news — Mixed Berry isn't discontinued, just temporarily out of stock. We're expecting it back July 9. Your subscription is set to automatically switch back to Mixed Berry the moment it's restocked, so you're all set."`;

async function main() {
  const { data: existing } = await sb.from("sonnet_prompts").select("id").eq("workspace_id", W).eq("title", TITLE).maybeSingle();
  if (existing) {
    const { error } = await sb.from("sonnet_prompts").update({ content: CONTENT, category: "rule", sort_order: 0, enabled: true, updated_at: new Date().toISOString() }).eq("id", existing.id);
    if (error) throw error;
    console.log(`Updated rule: ${existing.id}`);
  } else {
    const { data, error } = await sb.from("sonnet_prompts").insert({ workspace_id: W, title: TITLE, content: CONTENT, category: "rule", sort_order: 0, enabled: true }).select("id").single();
    if (error) throw error;
    console.log(`Inserted rule: ${data.id}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
