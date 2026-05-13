/**
 * Ticket 85e8aed9 (Stacy Rowles) — said "ok just pause it till then
 * thanks!" Opus replied "I've paused your subscription" but did
 * nothing. No return needed; just pause + set paused_at on the
 * crisis row (auto_resume + auto_readd already true).
 *
 *   npx tsx scripts/stacy-fix.ts            # dry run
 *   npx tsx scripts/stacy-fix.ts --apply    # do it
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
const TICKET_ID = "85e8aed9-ad6d-4b3e-bc4d-010ef9e7b46b";
const CUSTOMER_ID = "c8b919e7-2fd8-4741-a996-32fe4acca18f";
const SUB_CONTRACT = "27797389485";
const CRISIS_ACTION_ID = "05cb3407-5ffa-44ee-9a8e-338ee835a45e";

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

  console.log(`\n▶ Update crisis_customer_actions ${CRISIS_ACTION_ID} → paused_at=now`);
  if (APPLY) {
    const { error } = await admin.from("crisis_customer_actions").update({
      paused_at: new Date().toISOString(),
      ticket_id: TICKET_ID,
      updated_at: new Date().toISOString(),
    }).eq("id", CRISIS_ACTION_ID);
    if (error) { console.log("  ✗", error.message); process.exit(1); }
    console.log("  ✓ crisis row updated");
  }

  // Brief confirmation follow-up
  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name")
    .eq("id", CUSTOMER_ID)
    .single();
  const greeting = customer?.first_name ? `Hi ${customer.first_name},` : "Hi,";
  const body = `<p>${greeting}</p>
<p>Quick confirmation — your subscription is paused. When Mixed Berry is back in stock (expected July 9), we will automatically resume your subscription and ship you Mixed Berry, just like before. You will not be billed again until then, and you do not need to do anything on your end.</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`;

  console.log(`\n▶ Send email to ${customer?.email}`);
  if (APPLY && customer?.email) {
    const { data: ticket } = await admin
      .from("tickets")
      .select("subject, email_message_id, detected_language")
      .eq("id", TICKET_ID)
      .single();
    const { translateIfNeeded } = await import("../src/lib/translate");
    const outboundBody = await translateIfNeeded(
      body,
      (ticket?.detected_language as string | null) || "en",
      { workspaceId: W, ticketId: TICKET_ID },
    );
    const { sendTicketReply } = await import("../src/lib/email");
    const result = await sendTicketReply({
      workspaceId: W,
      toEmail: customer.email,
      subject: ticket?.subject || "Subscription paused",
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
        subject: ticket?.subject || "Subscription paused",
        ticketId: TICKET_ID,
        customerId: CUSTOMER_ID,
      });
    }

    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Operator Dylan: actually paused sub + set crisis paused_at (auto_resume + auto_readd were already true from initial enrollment).`,
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
