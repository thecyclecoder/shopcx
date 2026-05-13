/**
 * Ticket b3a65334 (Ashley McKeon) — has an active Mixed Berry sub
 * but isn't enrolled in the crisis. Opus told her about the OOS but
 * didn't enroll, pause, or set up auto-resume. Fix in-band:
 *   1. Pause her sub (contract 33759133869)
 *   2. Insert a crisis_customer_actions row tying her to the active
 *      Mixed Berry crisis, with paused_at + auto_resume=true so
 *      she's silently unpaused when Mixed Berry restocks.
 *   3. Send a chat reply confirming the plan and close the ticket.
 *
 *   npx tsx scripts/ashley-mckeon-fix.ts            # dry run
 *   npx tsx scripts/ashley-mckeon-fix.ts --apply    # do it
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const APPLY = process.argv.includes("--apply");
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "b3a65334-06e6-47a0-8961-abe37b2c1f04";
const CUSTOMER_ID = "2ebc716b-fbfd-4d07-bf73-54e6b16aa5e7";
const SUB_UUID = "8f232c0e-e9d0-443b-8a9a-1e872535e479";
const SUB_CONTRACT = "33759133869";
const CRISIS_ID = "94af0cbb-9005-4abf-9f93-ccac303907ee"; // Mixed Berry OOS

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  console.log(`\n▶ Pause subscription ${SUB_CONTRACT}`);
  if (APPLY) {
    const { appstleSubscriptionAction } = await import("../src/lib/appstle");
    const r = await appstleSubscriptionAction(W, SUB_CONTRACT, "pause");
    if (!r.success) { console.log("  ✗", r.error); process.exit(1); }
    console.log("  ✓ paused");
  }

  // Build the original_item snapshot from her current sub line — she's
  // still on Mixed Berry (auto-swap hasn't triggered yet) so this is
  // the variant she wants to keep on resolution.
  const originalItem = {
    sku: "SC-TABS-BERRY",
    title: "Superfood Tabs",
    quantity: 3,
    variant_id: "42614433448109",
    variant_title: "Mixed Berry",
  };

  console.log(`\n▶ Insert crisis_customer_actions row`);
  if (APPLY) {
    const { data, error } = await admin
      .from("crisis_customer_actions")
      .insert({
        crisis_id: CRISIS_ID,
        workspace_id: W,
        customer_id: CUSTOMER_ID,
        subscription_id: SUB_UUID,
        ticket_id: TICKET_ID,
        segment: "berry_only", // her sub only contains Mixed Berry
        current_tier: 1,
        paused_at: new Date().toISOString(),
        auto_resume: true,
        auto_readd: true,
        original_item: originalItem,
      })
      .select()
      .single();
    if (error) { console.log("  ✗", error.message); process.exit(1); }
    console.log(`  ✓ inserted: ${data.id}`);
  }

  console.log(`\n▶ Send chat reply + close`);
  if (APPLY) {
    const { data: ticket } = await admin
      .from("tickets")
      .select("subject, email_message_id, detected_language")
      .eq("id", TICKET_ID)
      .single();
    const body = `<p>Hi Ashley! Quick follow-up — I went ahead and paused your subscription so you won't get any Strawberry Lemonade in the meantime. We'll silently switch you back on when Mixed Berry is back (expected July 9), so your next shipment after the restock will be Mixed Berry exactly like you have it set up now. You don't need to do anything.</p>
<p>Julie at Superfoods Company</p>`;

    // Translate if customer's detected language ≠ en
    const { translateIfNeeded } = await import("../src/lib/translate");
    const outboundBody = await translateIfNeeded(
      body,
      (ticket?.detected_language as string | null) || "en",
      { workspaceId: W, ticketId: TICKET_ID },
    );

    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "external",
      author_type: "ai",
      body: outboundBody,
      sent_at: new Date().toISOString(),
    });

    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Operator Dylan: enrolled customer in crisis ${CRISIS_ID} (berry_only, paused_at=now, auto_resume=true, auto_readd=true). Sub paused.`,
    });

    await admin.from("tickets").update({
      status: "closed",
      closed_at: new Date().toISOString(),
      escalation_reason: null,
      updated_at: new Date().toISOString(),
    }).eq("id", TICKET_ID);
    console.log("  ✓ chat reply added, ticket closed");
  }

  console.log(`\n${APPLY ? "✅ Done" : "🔍 Dry run complete — re-run with --apply"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
