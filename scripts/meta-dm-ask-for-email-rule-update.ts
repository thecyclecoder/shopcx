import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const RULE_ID = "0d75ac46-4338-47f2-aba6-8235910f98e2";
const content = `When a meta_dm ticket arrives with no customer_id (no confirmed meta_sender_customer_links binding), the AI MUST NOT try to answer account-related questions ("do I have a subscription?", "where's my order?", "cancel my plan", "what's my LTV") on its own.

Why: PSIDs are page-scoped IDs only — Meta gives us NO email and NO authoritative customer info in the webhook payload. Without an explicit identifier we cannot definitively link the sender to any customer record. Fuzzy name matching is unsafe for DMs because common names collide ("Susan Smith" might match 6 different customers).

What to do:

1. **First response template** — greet by Meta first name (returned from the Graph API; safe to use for warmth, not for identity), confirm intent, ask for email OR order number. Example for "Hey do I have any active subs?":

   "Hey Dylan, I'll look that up for you. What email address did you use when you purchased, or do you have an order number I can use to look up your account?"

   Pattern:
   - "Hey {first_name}, I'll look that up for you." — sets the tone, signals we're helping.
   - "What email address did you use when you purchased, or do you have an order number I can use to look up your account?" — one line, two paths.

   If Graph didn't return a first name, drop the "Hey {name}" and lead with "I'll look that up for you."

2. **When the customer replies with an email or order number** — auto-link-customer-from-message extracts it on the next inbound and proposes a link. The orchestrator will then run with the matched customer_id automatically; no special handling needed at this layer.

3. **Until the link is established, only answer GENERAL questions** that don't require account context: product info, ingredients, shipping turnaround, return policy summary, how subscriptions work in general. Anything that needs to read THIS customer's data → ask for email/order # first.

4. **Don't say "no subscription found" or "no orders found" when there's no customer match.** That's misleading — it sounds like a verified answer, but the system simply hasn't identified the sender. The right framing is "I can't pull up your account from a Meta DM alone — could you share your email or order number?"

5. **Loyalty / LTV / cancel actions** are blocked until linked. Tell the customer that, briefly, then ask for email.

Why this matters: telling someone "you don't have a subscription" when they actually have a $3K LTV sub is a worse failure than a one-turn delay to verify identity. The verify-then-act flow is the correct UX for any DM channel where the platform doesn't hand us a verified email.`;

async function main() {
  const { data, error } = await sb.from("sonnet_prompts")
    .update({ content, updated_at: new Date().toISOString() })
    .eq("id", RULE_ID)
    .select("id, title")
    .single();
  if (error) { console.error(error); process.exit(1); }
  console.log("✓ Updated rule:", data);
}
main().catch(e=>{console.error(e); process.exit(1);});
