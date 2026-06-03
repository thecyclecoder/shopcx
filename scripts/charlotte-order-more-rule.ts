/**
 * Add a sonnet_prompt rule: when a customer asks for additional units
 * of a product they already have on a sub with a near-term renewal,
 * lead with renewal-adjust + bill_now as the SINGLE recommended path,
 * not a menu of 3 options.
 *
 * Reference ticket: Charlotte Frakes (98c2f6b6) 2026-06-03 — AI gave a
 * correct but fragmented 3-option answer when the cleanest move would
 * have been "your next renewal is on June 24th for $104.22; want me
 * to ship it now and bump coffee to 2 bags?"
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const title = "Customer asks for more of a product they already sub to — lead with renewal-adjust + bill_now, single path";
const content = `When a customer asks for additional units of a product they ALREADY have on an active subscription ("I need to order two more coffees", "can I get another bag", "send me extra"):

STEP 1 — Look up their sub.
- Active sub containing the product? Get current qty, price-per-unit, and next_billing_date.
- If next_billing_date is within ~6 weeks, treat it as the anchor for the response.
- If no active sub, or sub is paused, fall back to a one-time order at sub-tier pricing.

STEP 2 — Lead with ONE recommended path, not three.
- Bad (what we want to avoid): "Here are three options: add to next renewal, ship today, or one-time order at MSRP. Also you have loyalty points to apply."
- Good: "Your next renewal is on {date} for {current items + qty} at \${total}. I can ship it now and bump {product} to {new_qty} for \${adjusted_total} — want me to do that?"
- Single yes/no question. Confirm path BEFORE quoting coupons or loyalty redemption.

STEP 3 — When the customer confirms, use the correct tool.
- bill_now (NOT change_next_date with today's date — Appstle rejects past dates) to ship the renewal immediately.
- Adjust the line_item quantity FIRST if they want a permanent qty change; bill_now AFTER, so the renewal carries the new qty.
- If they want a one-time-only bump (not permanent), execute bill_now on the current renewal, then revert the qty afterward via a follow-up update.

STEP 4 — Loyalty redemption is a SECOND turn, not the first.
- Only mention loyalty points once the customer has chosen the order path. Sequencing it first creates decision fatigue and a fragmented flow.

Why: customers asking "I need X more" are usually trying to NOT run out. The fastest answer is "your stuff is already shipping on {date}, I can move that up and adjust the qty." Three-option menus + premature coupon offers slow them down and make the brand feel transactional.`;

async function main() {
  // Check for an existing similar rule first
  const { data: existing } = await sb.from("sonnet_prompts")
    .select("id, title")
    .eq("workspace_id", WS)
    .ilike("title", "%more of a product%");
  if (existing?.length) {
    console.log("Existing rule(s) match — skipping insert:", existing);
    return;
  }

  const { data, error } = await sb.from("sonnet_prompts").insert({
    workspace_id: WS,
    category: "rule",
    title,
    content,
    status: "approved",
    enabled: true,
    derived_from_ticket_id: "98c2f6b6-8c44-4ad4-ab91-17e6c495858e",
    reviewed_at: new Date().toISOString(),
  }).select("id, title").single();
  if (error) { console.error(error); process.exit(1); }
  console.log("✓ Inserted rule:", data);
}
main().catch(e=>{console.error(e); process.exit(1);});
