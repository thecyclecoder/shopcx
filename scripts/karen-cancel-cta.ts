/**
 * Karen (ticket c769e4ff) asked us to "just cancel temporarily" but
 * we can't actually click through her cancellation for her — the
 * journey is the customer-self-service path. Send a clear message
 * explaining that + re-send the cancel-journey CTA as a proper
 * styled button.
 *
 *   npx tsx scripts/karen-cancel-cta.ts            # dry run
 *   npx tsx scripts/karen-cancel-cta.ts --apply    # send
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
const TICKET_ID = "c769e4ff-d630-448a-9dad-b1b1401f3ffb";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  // Find the most recent cancel-journey token sent on this ticket so
  // we reuse it (don't burn a fresh token unless we have to).
  const { data: msgs } = await admin
    .from("ticket_messages")
    .select("body, created_at")
    .eq("ticket_id", TICKET_ID)
    .order("created_at", { ascending: false });
  const tokenMatch = (msgs || [])
    .map((m) => (m.body || "").match(/\/journey\/([a-f0-9]+)/))
    .find((m): m is RegExpMatchArray => !!m);
  if (!tokenMatch) { console.log("✗ no existing cancel journey token on ticket"); process.exit(1); }
  const token = tokenMatch[1];
  const journeyUrl = `https://shopcx.ai/journey/${token}`;
  console.log(`\nFound journey token: ${token.slice(0, 12)}…`);

  // Use the workspace's brand color for the button so it matches every
  // other journey CTA the customer has seen.
  const { data: ws } = await admin.from("workspaces").select("help_primary_color, name").eq("id", W).single();
  const color = ws?.help_primary_color || "#4f46e5";

  const button = `<a href="${journeyUrl}" style="display:inline-block;margin:8px 0;padding:12px 24px;background:${color};color:#ffffff !important;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;line-height:1;">Cancel Subscription &rsaquo;</a>`;

  const body = `<p>Hi Karen,</p>
<p>I'm unable to cancel for you directly — that has to come through the cancellation flow so we can confirm the details with you. If you click the button below, you'll be able to complete the cancellation in just a few clicks.</p>
<p>${button}</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`;

  const { data: ticket } = await admin
    .from("tickets")
    .select("subject, email_message_id, customer_id, detected_language")
    .eq("id", TICKET_ID)
    .single();
  const { data: customer } = await admin
    .from("customers")
    .select("email")
    .eq("id", ticket!.customer_id!)
    .single();

  // Run through translateIfNeeded (no-op for English)
  const { translateIfNeeded } = await import("../src/lib/translate");
  const outboundBody = await translateIfNeeded(
    body,
    (ticket?.detected_language as string | null) || "en",
    { workspaceId: W, ticketId: TICKET_ID },
  );

  console.log("\n--- BODY ---");
  console.log(outboundBody);
  console.log("--- END ---");

  if (!APPLY) {
    console.log("\n🔍 Dry run complete — re-run with --apply");
    return;
  }

  const { sendTicketReply } = await import("../src/lib/email");
  const result = await sendTicketReply({
    workspaceId: W,
    toEmail: customer!.email!,
    subject: ticket?.subject || "Re: Your cancellation",
    body: outboundBody,
    inReplyTo: ticket?.email_message_id || null,
    agentName: "Suzie",
    workspaceName: ws?.name || "Superfoods Company",
  });
  if (result.error) { console.log("✗", result.error); process.exit(1); }
  console.log(`✓ sent (${result.messageId})`);

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
      recipientEmail: customer!.email!,
      subject: ticket?.subject || "Re: Your cancellation",
      ticketId: TICKET_ID,
      customerId: ticket!.customer_id!,
    });
  }

  await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] Operator Dylan: re-sent cancel journey CTA as a proper styled button with explanation that the customer needs to complete cancellation themselves.`,
  });

  await admin.from("tickets").update({
    status: "pending",
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET_ID);
  console.log("✓ ticket set to pending");
}

main().catch((e) => { console.error(e); process.exit(1); });
