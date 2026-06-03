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

const title = "Meta DM with no customer match — ask for email or order number FIRST, don't guess";
const content = `When a meta_dm ticket arrives with no customer_id (no confirmed meta_sender_customer_links binding), the AI MUST NOT try to answer account-related questions ("do I have a subscription?", "where's my order?", "cancel my plan", "what's my LTV") on its own.

Why: PSIDs are page-scoped IDs only — Meta gives us NO email and NO authoritative customer info in the webhook payload. Without an explicit identifier we cannot definitively link the sender to any customer record. Fuzzy name matching is unsafe for DMs because common names collide ("Susan Smith" might match 6 different customers).

What to do:

1. **First response for an account-related question on an unmatched DM** — ask for the email address on their account, or an order number. Keep it brief. Example:
   "Happy to help! Could you share the email address you used to place your order, or an order number (like SC123456)? That'll let me pull up your account."

2. **When the customer replies with an email or order number** — auto-link-customer-from-message extracts it on the next inbound and proposes a link. The orchestrator will then run with the matched customer_id automatically; no special handling needed at this layer.

3. **Until the link is established, only answer GENERAL questions** that don't require account context: product info, ingredients, shipping turnaround, return policy summary, how subscriptions work in general. Anything that needs to read THIS customer's data → ask for email/order # first.

4. **Don't say "no subscription found" or "no orders found" when there's no customer match.** That's misleading — it sounds like a verified answer, but the system simply hasn't identified the sender. Say "I can't find your account from your Meta profile alone — could you share your email?" instead.

5. **Loyalty / LTV / cancel actions** are blocked until linked. Tell the customer that, briefly, then ask for email.

Why this matters: telling someone "you don't have a subscription" when they actually have a $3K LTV sub is a worse failure than a one-turn delay to verify identity. The verify-then-act flow is the correct UX for any DM channel where the platform doesn't hand us a verified email.`;

async function main() {
  const { data: existing } = await sb.from("sonnet_prompts")
    .select("id, title")
    .eq("workspace_id", WS)
    .or("title.ilike.%meta dm%no customer%,title.ilike.%ask for email%dm%");
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
    derived_from_ticket_id: "1bb06bb8-f5dc-4a54-8666-648bd0baf436",
    reviewed_at: new Date().toISOString(),
  }).select("id, title").single();
  if (error) { console.error(error); process.exit(1); }
  console.log("✓ Inserted rule:", data);
}
main().catch(e=>{console.error(e); process.exit(1);});
