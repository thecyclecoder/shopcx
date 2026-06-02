/**
 * For each ticket: email the customer to confirm the coupon was
 * applied (the earlier ticket_messages row only shows up in chat
 * widget polls, and these chats are hours-old). Then unescalate
 * and close.
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

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

const CASES = [
  {
    ticketId: "981bf7c0-6d18-4f54-91aa-20862dc8e0ec",
    customerId: "21f10892-da93-473a-8be9-79ccc8cbea2c",
    name: "Sherri McNeely",
    body: `<p>Hi Sherri,</p>
<p>Just confirming — I swapped your subscription to Peach Mango and applied a 20% off coupon for the inconvenience. Both will take effect on your next renewal.</p>
<p>Sorry again for the Mixed Berry confusion. If you'd like to switch flavors again or have any questions, just reply.</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`,
  },
  {
    ticketId: "6123836f-51d2-42dc-8d92-dc89edfc3795",
    customerId: "36bb5ad6-9e82-4c9e-8a9c-2d898445f60e",
    name: "Jennifer Lujan",
    body: `<p>Hi Jennifer,</p>
<p>Quick update — your $15 loyalty coupon (LOYALTY-15-8JJ66Z) is now applied to your subscription. It'll come off your next renewal on May 1st.</p>
<p>Your second $15 coupon (LOYALTY-15-5UWVGZ) is saved on your account — only one coupon can be active on a subscription at a time, so we'll keep that one for a future renewal or one-time order.</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`,
  },
];

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  for (const c of CASES) {
    console.log(`\n=== ${c.name} (${c.ticketId.slice(0, 8)}) ===`);

    const { data: cust } = await admin
      .from("customers")
      .select("email")
      .eq("id", c.customerId)
      .single();
    const { data: t } = await admin
      .from("tickets")
      .select("subject, email_message_id, status, escalated_at, assigned_to")
      .eq("id", c.ticketId)
      .single();
    console.log(`  → ${cust?.email}`);
    console.log(`  ticket: status=${t?.status} escalated_at=${t?.escalated_at?.slice(0,16) || "—"} assigned_to=${t?.assigned_to ? t.assigned_to.slice(0,8) : "—"}`);

    if (!APPLY) continue;

    // 1. Send confirmation through ticket
    const { sendTicketReply } = await import("../src/lib/email");
    const { data: ws } = await admin.from("workspaces").select("name").eq("id", W).single();
    const subject = t?.subject?.startsWith("Re:") ? t.subject : `Re: ${t?.subject || "Your subscription"}`;

    const result = await sendTicketReply({
      workspaceId: W,
      toEmail: cust!.email,
      subject,
      body: c.body,
      inReplyTo: t?.email_message_id || null,
      agentName: "Suzie",
      workspaceName: ws?.name || "Superfoods Company",
    });
    if (result.error) {
      console.log(`  ✗ email error: ${result.error}`);
      continue;
    }
    console.log(`  ✓ confirmation email sent (resend ${result.messageId})`);

    // Insert ticket message + email tracking + thread id (so any reply lands here)
    await admin.from("ticket_messages").insert({
      ticket_id: c.ticketId,
      direction: "outbound",
      visibility: "external",
      author_type: "ai",
      body: c.body,
      sent_at: new Date().toISOString(),
      resend_email_id: result.messageId || null,
      email_status: result.messageId ? "sent" : null,
      email_message_id: result.messageId ? `<${result.messageId}@resend.dev>` : null,
    });
    if (result.messageId) {
      const emailMsgId = `<${result.messageId}@resend.dev>`;
      // Set ticket.email_message_id only if it wasn't set (chat tickets start without it)
      if (!t?.email_message_id) {
        await admin.from("tickets").update({ email_message_id: emailMsgId }).eq("id", c.ticketId);
      }
      const { logEmailSent } = await import("../src/lib/email-tracking");
      await logEmailSent({
        workspaceId: W,
        resendEmailId: result.messageId,
        recipientEmail: cust!.email,
        subject,
        ticketId: c.ticketId,
        customerId: c.customerId,
      });
    }

    // 2. Unescalate + close
    await admin
      .from("tickets")
      .update({
        status: "closed",
        assigned_to: null,
        escalated_to: null,
        escalated_at: null,
        escalation_reason: null,
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.ticketId);

    await admin.from("ticket_messages").insert({
      ticket_id: c.ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: "[System] Operator: coupon was successfully applied via re-run, customer confirmation emailed, ticket unescalated + closed.",
    });
    console.log("  ✓ unescalated + closed");
  }

  console.log(`\n${APPLY ? "✅ Done" : "🔍 Dry run — re-run with --apply"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
