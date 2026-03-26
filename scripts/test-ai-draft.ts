#!/usr/bin/env npx tsx
/**
 * End-to-end AI draft test using a real Gorgias ticket message.
 *
 * This script:
 * 1. Creates a test AI personality (if none exists)
 * 2. Enables AI on the email channel with sandbox mode
 * 3. Creates a temporary test ticket with a real customer message
 * 4. Runs the AI draft system against it
 * 5. Shows the result vs what Siena AI actually replied
 * 6. Cleans up the test ticket
 *
 * Run: npx tsx scripts/test-ai-draft.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Use Dylan's real customer record, but simulate the Gorgias cancel request scenario
const CUSTOMER_ID = "231a426a-b821-4f3d-9798-e52fabee639d"; // dylan@superfoodscompany.com

const TEST_CASE = {
  subject: "Cancel any subscriptions - Send us a message",
  customer_message: "I need to cancel all of my subscriptions immediately. I don't want to be charged again. Please confirm cancellation.",
  channel: "email",
  // What Siena actually replied to the original customer:
  siena_reply: `Hello Debbie!\n\nThank you so much for contacting Superfoods Company!\n\nWe did not locate an order or subscription under the name Debbie Alexander or the email tutonedebbie@gmail.com. Would you mind sending us the email address associated with your subscription so we can assist you further?`,
  siena_tags: ["cancel_request", "unknownaccount", "handled-by-siena"],
};

async function main() {
  console.log("=== ShopCX AI Draft Test ===\n");

  // Step 1: Ensure personality exists
  console.log("1. Checking AI personality...");
  let { data: personalities } = await supabase
    .from("ai_personalities")
    .select("id")
    .eq("workspace_id", WORKSPACE_ID);

  let personalityId: string;
  if (!personalities?.length) {
    console.log("   Creating test personality...");
    const { data: p } = await supabase
      .from("ai_personalities")
      .insert({
        workspace_id: WORKSPACE_ID,
        name: "Superfoods Support",
        description: "Friendly, helpful customer support for Superfoods Company",
        tone: "friendly",
        style_instructions: "Be warm and empathetic. Use the customer's first name. Keep responses concise but thorough. Always offer to help further.",
        greeting: "Hi {{name}}!",
        sign_off: "Best,\nThe Superfoods Company Team",
        emoji_usage: "minimal",
      })
      .select()
      .single();
    personalityId = p!.id;
    console.log(`   Created: ${p!.name} (${personalityId})`);
  } else {
    personalityId = personalities[0].id;
    console.log(`   Using existing personality: ${personalityId}`);
  }

  // Step 2: Enable AI on email channel
  console.log("\n2. Configuring email channel...");
  await supabase.from("ai_channel_config").upsert({
    workspace_id: WORKSPACE_ID,
    channel: "email",
    personality_id: personalityId,
    enabled: true,
    sandbox: true,
    instructions: "Be helpful and empathetic. If the customer wants to cancel, acknowledge their request and check for their subscription. Always use their first name.",
    confidence_threshold: 0.95,
    auto_resolve: false,
  }, { onConflict: "workspace_id,channel" });
  console.log("   Email channel enabled (sandbox mode)");

  // Step 3: Use Dylan's real customer record
  console.log("\n3. Using customer: dylan@superfoodscompany.com...");
  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("id", CUSTOMER_ID)
    .single();
  if (!customer) { console.error("Customer not found"); process.exit(1); }
  console.log(`   Customer: ${customer.email} (${customer.id}) — ${customer.subscription_status}`);

  // Step 4: Create test ticket
  console.log("\n4. Creating test ticket...");
  const { data: ticket, error: tErr } = await supabase
    .from("tickets")
    .insert({
      workspace_id: WORKSPACE_ID,
      customer_id: customer.id,
      subject: TEST_CASE.subject,
      status: "open",
      channel: TEST_CASE.channel,
    })
    .select()
    .single();
  if (tErr || !ticket) { console.error("Ticket error:", tErr?.message); process.exit(1); }
  console.log(`   Ticket: ${ticket.id} — "${ticket.subject}"`);

  // Add customer message
  const { error: mErr } = await supabase.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "inbound",
    body: TEST_CASE.customer_message,
    author_type: "customer",
    visibility: "external",
  });
  if (mErr) { console.error("Message error:", mErr.message); process.exit(1); }
  console.log(`   Message added: "${TEST_CASE.customer_message.slice(0, 80)}..."`);

  // Step 5: Run AI draft
  console.log("\n5. Generating AI draft...");
  console.log("   (This calls Claude + RAG retrieval — may take 5-10 seconds)\n");

  // Import and run the draft generator directly
  const { generateAIDraft } = await import("../src/lib/ai-draft");
  const result = await generateAIDraft(WORKSPACE_ID, ticket!.id);

  // Step 6: Show results
  console.log("=" .repeat(60));
  console.log("RESULTS");
  console.log("=" .repeat(60));

  console.log(`\nConfidence: ${Math.round(result.confidence * 100)}%`);
  console.log(`Tier: ${result.tier}`);
  console.log(`Source: ${result.source_type || "none"} (ID: ${result.source_id || "none"})`);
  console.log(`AI Workflow: ${result.ai_workflow_id || "none"}`);
  console.log(`Sandbox: ${result.sandbox}`);
  console.log(`Reasoning: ${result.reasoning}`);

  console.log("\n--- OUR AI DRAFT ---");
  console.log(result.draft || "(no draft generated)");

  console.log("\n--- SIENA'S ACTUAL REPLY ---");
  console.log(TEST_CASE.siena_reply);

  console.log("\n--- COMPARISON ---");
  if (result.draft) {
    console.log("✓ AI generated a draft response");
    console.log(`  Confidence: ${Math.round(result.confidence * 100)}% (threshold: 95% for auto-resolve)`);
    if (result.source_type === "macro") {
      // Get macro name
      const { data: macro } = await supabase.from("macros").select("name").eq("id", result.source_id!).single();
      console.log(`  Matched macro: "${macro?.name}"`);
    } else if (result.source_type === "kb") {
      const { data: kb } = await supabase.from("knowledge_base").select("title").eq("id", result.source_id!).single();
      console.log(`  Matched KB article: "${kb?.title}"`);
    }
  } else {
    console.log("✗ No draft generated (tier: human)");
  }

  // Step 7: Cleanup
  console.log("\n7. Cleaning up test data...");
  await supabase.from("ticket_messages").delete().eq("ticket_id", ticket.id);
  await supabase.from("tickets").delete().eq("id", ticket.id);
  console.log("   Cleaned up test ticket (customer record preserved)");

  console.log("\nDone!");
}

main().catch(console.error);
