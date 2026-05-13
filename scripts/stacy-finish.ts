/** Finish what stacy-fix.ts started — sub is paused, crisis row
 *  updated, just need to send the confirmation email + close. */
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
const TICKET = "85e8aed9-ad6d-4b3e-bc4d-010ef9e7b46b";
const CUST = "c8b919e7-2fd8-4741-a996-32fe4acca18f";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: customer } = await admin.from("customers")
    .select("email, first_name").eq("id", CUST).single();
  const { data: ticket } = await admin.from("tickets")
    .select("subject, email_message_id").eq("id", TICKET).single();

  const body = `<p>Hi ${customer?.first_name || "there"},</p>
<p>Quick confirmation — your subscription is paused. When Mixed Berry is back in stock (expected July 9), we will automatically resume your subscription and ship you Mixed Berry, just like before. You will not be billed again until then, and you do not need to do anything on your end.</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`;

  const { sendTicketReply } = await import("../src/lib/email");
  const result = await sendTicketReply({
    workspaceId: W,
    toEmail: customer!.email!,
    subject: ticket?.subject || "Subscription paused",
    body,
    inReplyTo: ticket?.email_message_id || null,
    agentName: "Suzie",
    workspaceName: "Superfoods Company",
  });
  if (result.error) { console.log("✗", result.error); process.exit(1); }
  console.log("✓ sent", result.messageId);

  await admin.from("ticket_messages").insert({
    ticket_id: TICKET, direction: "outbound", visibility: "external", author_type: "ai",
    body, sent_at: new Date().toISOString(),
    resend_email_id: result.messageId || null,
    email_status: result.messageId ? "sent" : null,
    email_message_id: result.messageId ? `<${result.messageId}@resend.dev>` : null,
  });
  if (result.messageId) {
    const { logEmailSent } = await import("../src/lib/email-tracking");
    await logEmailSent({
      workspaceId: W, resendEmailId: result.messageId,
      recipientEmail: customer!.email!, subject: ticket?.subject || "Subscription paused",
      ticketId: TICKET, customerId: CUST,
    });
  }
  await admin.from("ticket_messages").insert({
    ticket_id: TICKET, direction: "outbound", visibility: "internal", author_type: "system",
    body: "[System] Operator Dylan: completed pause (Appstle returned 504 but sub did pause). Crisis row updated + confirmation sent.",
  });
  await admin.from("tickets").update({
    status: "closed", closed_at: new Date().toISOString(),
    escalation_reason: null, updated_at: new Date().toISOString(),
  }).eq("id", TICKET);
  console.log("✓ closed");
}

main().catch((e) => { console.error(e); process.exit(1); });
