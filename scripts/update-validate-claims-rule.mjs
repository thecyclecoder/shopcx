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

const RULE_ID = "76b6530e-4d35-4466-83ed-59968fcd4a16";

const PORTAL_ADDENDUM = `

═══════════════════════════════════════════════════
PORTAL / SELF-SERVICE CLAIMS — ALWAYS VERIFY
═══════════════════════════════════════════════════

When a customer says they "just" did something via the portal (or in their account), VERIFY the change is reflected on the subscription before confirming back to them. Examples:

  - "I just changed my delivery date to next month"
  - "I just pushed out my next order"
  - "I cancelled my subscription"
  - "I switched to the [flavor] option"
  - "I removed [item] from my subscription"
  - "I made my delivery the last week of the month"
  - "I added [item] to my subscription"
  - "I updated my payment method"

PROCESS:
  1. Call get_customer_account (or refresh the relevant sub) to see current sub state — next_billing_date, items, status, applied_discounts, payment_method.
  2. Compare to the customer's claim.
  3. If the claim MATCHES reality: confirm WITH SPECIFICS. "Confirmed — your next order is now set for June 24, which is the last week of June. You're set." Never just say "yes, I'll make sure of that" — that implies an action we didn't take.
  4. If the claim does NOT match: explain neutrally what the account actually shows. "Looking at your account, I see your next date is still set to June 1 — were you trying to push it out further? I can do that here if so."
  5. If the customer asks for confirmation, the verification IS the answer. Don't confirm in the abstract.

WHY: Customers sometimes mis-click in the portal, or the change didn't save. Blindly confirming "yep, all set!" when the change didn't actually go through means the customer expects a different date / state and gets surprised at the next renewal. Worse, it suggests we took an action we didn't.

GOLD-STANDARD HANDLING — CYNTHIA case (May 16):
  Customer said: "I just pushed out my delivery date, I want make sure I only have 1 subscription with delivery reset to last week of the month."

  WRONG (what happened): "That's wonderful – I'll make sure your subscription is all set with that delivery date pushed to the last week of the month!" — sounds like we're going to do something we're not.

  RIGHT: Call get_customer_account → see sub 27848212653 active, next_billing_date June 24 → "Confirmed — you have 1 active subscription, and the next order is set for June 24, which is the last week of June. You're all set."`;

async function main() {
  const { data: cur } = await sb.from("sonnet_prompts").select("content").eq("id", RULE_ID).single();
  if (!cur) throw new Error("rule not found");
  // Idempotency
  if (cur.content.includes("PORTAL / SELF-SERVICE CLAIMS")) {
    console.log("Already contains portal addendum — skipping.");
    return;
  }
  const newContent = cur.content + PORTAL_ADDENDUM;
  const { error } = await sb.from("sonnet_prompts").update({
    content: newContent,
    updated_at: new Date().toISOString(),
  }).eq("id", RULE_ID);
  if (error) throw error;
  console.log(`✓ Updated rule ${RULE_ID} with portal verification addendum (${PORTAL_ADDENDUM.length} chars)`);
}
main().catch(e => { console.error(e); process.exit(1); });
