// Fix the "post-renewal regret" prompt that intercepts cancel requests
// with a save attempt instead of routing to the cancel journey.
//
// Strategy:
//   1. Disable the existing pre-cancel save rule (id 087696d2…)
//   2. Add a new POST-cancel courtesy rule that mentions loyalty points
//      AFTER the cancel journey completes — never before.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRE_CANCEL_RULE_ID = "087696d2-4f68-4b18-b7c2-bb48a07c8a03";

// 1. Disable the offending rule
const { error: e1 } = await admin.from("sonnet_prompts")
  .update({ enabled: false, updated_at: new Date().toISOString() })
  .eq("id", PRE_CANCEL_RULE_ID);
if (e1) { console.error("Failed to disable:", e1); process.exit(1); }
console.log(`✓ Disabled #10 "Post-renewal regret" (${PRE_CANCEL_RULE_ID})`);

// 2. Add a new rule: post-cancel courtesy mention (never pre-cancel)
const POST_CANCEL_TITLE = "Post-cancel courtesy — mention loyalty AFTER cancel only";
const POST_CANCEL_CONTENT = `POST-CANCEL COURTESY MENTIONS — never pre-cancel.

When a customer asks to cancel, route them to the cancel_subscription journey IMMEDIATELY. Never offer loyalty refunds, pause, skip, or any other save remedy before the journey runs — those remedies are inside the cancel journey itself, and intercepting before the journey ignores what the customer actually asked for.

The cancel journey handles retention. Your job is to honor the explicit cancel request and route.

POST-CANCEL ONLY: After the cancel_subscription journey has completed and the subscription is actually cancelled, when you send the cancellation confirmation, you MAY add ONE soft courtesy mention. Use it only when ALL of the following are true:

  1. The cancel journey just completed (you see "Action completed: cancel" in conversation history).
  2. The customer has 500+ loyalty points (from get_customer_account).
  3. The most recent order is a subscription_contract renewal from the last 7 days.

If all three hold, the confirmation message can read like this (one short sentence, never pushy):
  "Your subscription has been cancelled — you won't be charged again. By the way, you still have {points} loyalty points on file; if you ever come back, those points are waiting for you."

ABSOLUTE RULES:
  • Do NOT offer the loyalty redemption as a save before cancel.
  • Do NOT offer pause as an alternative to cancel before the journey.
  • Do NOT use action_type "ai_response" with save offers when the customer asked to cancel.
  • If the customer's first message contains "cancel" / "stop" / "end my subscription", route to the cancel_subscription journey, period. The journey is where save remedies live.

WHY: Customers who say "please cancel" are giving you an instruction. Trying to save them before respecting that instruction reads as ignoring their request. Save offers belong inside the journey (where they're framed as choices the customer makes), not as pre-cancel intercepts.`;

const { error: e2 } = await admin.from("sonnet_prompts").upsert({
  workspace_id: W,
  category: "rule",
  title: POST_CANCEL_TITLE,
  content: POST_CANCEL_CONTENT,
  sort_order: 2,
  enabled: true,
  updated_at: new Date().toISOString(),
}, { onConflict: "workspace_id,title" }).select("id");

if (e2) {
  // upsert may fail if there's no unique constraint on (workspace_id, title);
  // fall back to insert/skip-if-exists
  const { data: existing } = await admin.from("sonnet_prompts")
    .select("id").eq("workspace_id", W).eq("title", POST_CANCEL_TITLE).maybeSingle();
  if (existing) {
    const { error: e3 } = await admin.from("sonnet_prompts")
      .update({ content: POST_CANCEL_CONTENT, sort_order: 2, enabled: true, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (e3) { console.error("Update fail:", e3); process.exit(1); }
    console.log(`✓ Updated existing post-cancel rule (${existing.id})`);
  } else {
    const { data: inserted, error: e4 } = await admin.from("sonnet_prompts").insert({
      workspace_id: W,
      category: "rule",
      title: POST_CANCEL_TITLE,
      content: POST_CANCEL_CONTENT,
      sort_order: 2,
      enabled: true,
    }).select("id").single();
    if (e4) { console.error("Insert fail:", e4); process.exit(1); }
    console.log(`✓ Inserted new post-cancel rule (${inserted.id})`);
  }
} else {
  console.log("✓ Upserted post-cancel rule");
}

console.log("\nDone. Sonnet/Opus will now route cancel requests directly to the journey, with no pre-save intercept.");
