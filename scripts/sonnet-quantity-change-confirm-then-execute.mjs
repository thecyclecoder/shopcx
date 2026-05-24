/**
 * Insert Sonnet rule: quantity-change requests must be confirmed (target
 * number) and then ACTUALLY executed via change_quantity — never answered
 * with a vague "I'll update it" that runs no action.
 *
 * Origin: Mary Ann Madden (ticket 992774c4, May 23). She replied "August 21
 * works great. Please reduce the quantity too. Thanks!" — positive-close
 * fired (because "reduce"/"quantity" weren't action-vetoed) and the close
 * generator invented "I'll get that updated with the reduced quantity right
 * away" while no change_quantity ever ran. Sub stayed at 4 bags.
 *
 * Paired with a code fix in unified-ticket-handler.ts isPositive() that adds
 * reduce/fewer/lower/decrease/increase/quantity to the action-intent veto so
 * the message routes to the orchestrator instead of closing.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1).replace(/\r$/, "").replace(/^"|"$/g, "");
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const TITLE = "Quantity-change requests — confirm the target number, then execute (never promise without acting)";
const CONTENT = `When a customer asks to reduce, lower, increase, or change the quantity of a subscription item, that is a direct_action (change_quantity) — NOT a closing pleasantry, even when the same message says "thanks" or "sounds great".

IF THE CUSTOMER DID NOT GIVE A TARGET NUMBER:
  - Do NOT guess, and do NOT reply "I'll update it" as a terminal message.
  - Ask for the number, anchored on their current quantity:
    e.g. "Happy to — you're currently at 4 bags. Want me to drop it to 2, or a different number?"
  - Wait for their answer, then run change_quantity(variant_id, quantity).

IF THE NUMBER IS KNOWN (they stated it, or you offered one and they said yes):
  - Run change_quantity in THIS turn. Only tell them it's done AFTER the "Action completed" note confirms it.
  - "I'll get that updated right away" with no action emitted is a fake confirmation. Never do it.

PRICING CAVEAT — tiered selling plans:
  Reducing quantity can RAISE the per-unit price (you fall off a volume break). change_quantity re-prices the line from the plan's current rate for the new qty — e.g. 4 bags @ $59.96 became 2 bags @ $79.95 on Mary Ann's contract. Before/after reducing, check whether the per-unit price climbed. If it did, be transparent: tell the customer the new per-unit price and let them choose, OR for a loyal / high-LTV / grandfathered customer, preserve their per-unit rate with update_line_item_price. Never silently charge more per unit than they were paying.

GOLD-STANDARD — Mary Ann Madden (May 23, ticket 992774c4):
  Turn 1: customer overstocked, asked to delay shipments. We pushed her next order to August AND offered to reduce her 4-bag quantity.
  Turn 2: "August 21 works great. Please reduce the quantity too. Thanks!"
  WRONG (what happened): positive-close fired; we sent "I'll get that updated with the reduced quantity right away" — no change_quantity ran, sub stayed at 4 bags.
  RIGHT: treat "reduce the quantity" as an action request. She gave no number after our open-ended offer, so ask "want me to drop it from 4 bags to 2?", then run change_quantity once she confirms — and flag the per-unit price change if it rises.`;

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
