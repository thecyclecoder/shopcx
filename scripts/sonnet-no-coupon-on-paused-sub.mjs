/**
 * Insert Sonnet rule: don't recommend applying a loyalty coupon to a
 * paused subscription — the discount won't be used until the sub
 * resumes, and "resumes" may be tied to an OOS restock the customer
 * already knows is months out.
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

const TITLE = "Loyalty redemption — don't recommend applying to a paused sub or an OOS product";
const CONTENT = `When a customer asks about applying loyalty points to a subscription (or you're considering offering it), check the destination sub BEFORE making the recommendation.

DON'T recommend applying the coupon when ANY of these are true:

1. The sub is PAUSED. A coupon on a paused sub doesn't discount anything until the sub resumes — and the customer often paused it for a reason (took a break, products out of stock, etc.). Discounting an inert sub feels like nothing happened.

2. The sub's primary product is OUT OF STOCK or on a crisis hold. Even if the sub is technically "active" or auto-resume, the next renewal can't ship until restock, so the discount sits unused.

3. The sub's primary product was just swapped due to a crisis (e.g. Mixed Berry → Strawberry Lemonade temporarily). The customer may not want the discount eaten by the swap variant.

INSTEAD, recommend saving the points for when a sub is actively shipping, OR offer to apply them as a one-time-purchase coupon (LOYALTY codes work at one-time checkout too).

GOLD-STANDARD HANDLING — Janet case (May 17):
  Customer's Superfood Tabs sub: paused (waiting for Mixed Berry restock July 9).
  Customer's ACV Gummies sub: paused (and the gummies are OOS in Shopify).
  Customer asked: "can I apply 1,500 points?"

  WRONG (what happened):
    "I can redeem the full $15 off now and apply it to your ACV Gummies subscription so it's waiting on that next renewal."
    → both subs are paused, gummies are OOS, the discount won't actually be used soon.

  RIGHT:
    "I can redeem 1,500 points for $15 off — but both your subs are paused right now (Tabs is waiting on Mixed Berry, Gummies is too), so the discount would just sit there. Two cleaner options: (1) save the points for when a sub resumes shipping, or (2) issue the code now and you can use it on a one-time order whenever. Which works?"

The rule also applies to apply_coupon (not just loyalty). Any "apply discount to subscription" recommendation needs the sub to actually be shipping.`;

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
