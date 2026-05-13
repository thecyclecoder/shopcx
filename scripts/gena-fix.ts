/**
 * Ticket a14e3d82 (Gena Bunker) — Opus created the return but didn't
 * pause the subscription she explicitly asked for. Pause it + set
 * crisis auto_resume=true so she's silently unpaused when Mixed
 * Berry comes back. auto_readd is already true on her record.
 *
 *   npx tsx scripts/gena-fix.ts            # dry run
 *   npx tsx scripts/gena-fix.ts --apply    # do it
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
const TICKET_ID = "a14e3d82-e488-4799-b45f-3a32ace29a78";
const CUSTOMER_ID = "87b60435-f06e-4a85-ac42-377578e55310";
const SUB_UUID = "4bb9fff8-bff3-4a60-a731-7fe912c8f6b4";
const CRISIS_ACTION_ID = "e685357a-8979-46fe-9fcb-2f7279feb11c";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { data: sub } = await admin
    .from("subscriptions")
    .select("shopify_contract_id, status")
    .eq("id", SUB_UUID)
    .single();
  if (!sub) { console.log("✗ subscription not found"); process.exit(1); }
  console.log(`\nSub ${sub.shopify_contract_id} status=${sub.status}`);
  if (sub.status === "paused") {
    console.log("  already paused — skipping pause step.");
  }

  console.log(`\n▶ Pause subscription ${sub.shopify_contract_id}`);
  if (APPLY && sub.status !== "paused") {
    const { appstleSubscriptionAction } = await import("../src/lib/appstle");
    const r = await appstleSubscriptionAction(W, sub.shopify_contract_id, "pause");
    if (!r.success) { console.log("  ✗", r.error); process.exit(1); }
    console.log("  ✓ paused");
  }

  console.log(`\n▶ Update crisis_customer_actions → paused_at, auto_resume=true, ticket_id`);
  if (APPLY) {
    const { error } = await admin.from("crisis_customer_actions").update({
      paused_at: new Date().toISOString(),
      auto_resume: true,
      ticket_id: TICKET_ID,
      updated_at: new Date().toISOString(),
    }).eq("id", CRISIS_ACTION_ID);
    if (error) { console.log("  ✗", error.message); process.exit(1); }
    console.log("  ✓ updated");
  }

  // Customer-facing follow-up confirming the pause + auto-resume plan
  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name")
    .eq("id", CUSTOMER_ID)
    .single();
  const greeting = customer?.first_name ? `Hi ${customer.first_name},` : "Hi,";
  const body = `<p>${greeting}</p>
<p>Quick follow-up — I've now paused your monthly subscription so you won't be charged on May 23. We've also flagged your account so you'll be silently switched back to Mixed Berry as soon as it's restocked (currently expected July 9). No need to do anything on your end — your next shipment after the restock will be Mixed Berry, automatically.</p>
<p>Your return label for the Strawberry Lemonade order is already in your inbox from earlier. Once we receive it back, your full refund processes right away.</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`;

  console.log(`\n▶ Send confirmation email to ${customer?.email}`);
  if (APPLY && customer?.email) {
    const { sendTicketReply } = await import("../src/lib/email");
    const { data: ticket } = await admin
      .from("tickets")
      .select("subject, email_message_id, detected_language")
      .eq("id", TICKET_ID)
      .single();
    // Run through translate for consistency with the new pipeline
    const { translateIfNeeded } = await import("../src/lib/translate");
    const outboundBody = await translateIfNeeded(
      body,
      ticket?.detected_language || "en",
      { workspaceId: W, ticketId: TICKET_ID },
    );
    const result = await sendTicketReply({
      workspaceId: W,
      toEmail: customer.email,
      subject: ticket?.subject || "Your subscription is paused",
      body: outboundBody,
      inReplyTo: ticket?.email_message_id || null,
      agentName: "Suzie",
      workspaceName: "Superfoods Company",
    });
    if (result.error) { console.log("  ✗", result.error); process.exit(1); }
    console.log(`  ✓ sent (${result.messageId})`);

    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "external",
      author_type: "ai",
      body: outboundBody,
      sent_at: new Date().toISOString(),
      resend_email_id: result.messageId || null,
      email_status: result.messageId ? "sent" : null,
      email_message_id: result.messageId ? `<${result.messageId}@resend.dev>` : null,
    });

    if (result.messageId) {
      const { logEmailSent } = await import("../src/lib/email-tracking");
      await logEmailSent({
        workspaceId: W,
        resendEmailId: result.messageId,
        recipientEmail: customer.email,
        subject: ticket?.subject || "Your subscription is paused",
        ticketId: TICKET_ID,
        customerId: CUSTOMER_ID,
      });
    }

    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Operator Dylan: paused sub, set crisis auto_resume=true (auto_readd was already true). Sent confirmation email.`,
    });

    await admin.from("tickets").update({
      status: "closed",
      closed_at: new Date().toISOString(),
      escalation_reason: null,
      updated_at: new Date().toISOString(),
    }).eq("id", TICKET_ID);
    console.log("  ✓ ticket closed");
  }

  console.log(`\n${APPLY ? "✅ Done" : "🔍 Dry run complete — re-run with --apply"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
