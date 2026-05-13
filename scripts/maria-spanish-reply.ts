/**
 * Reply to ticket 45dc8b15 (Maria) in Spanish with the actual
 * tracking states for her two orders:
 *   - SC129548 (May 3) — delivered (DHL Smart Mail)
 *   - SC129756 (May 6) — in transit (USPS)
 *
 * Uses the new translateIfNeeded helper so this also exercises the
 * pipeline that will be wired into the inbound handler.
 *
 *   npx tsx scripts/maria-spanish-reply.ts            # dry run
 *   npx tsx scripts/maria-spanish-reply.ts --apply    # send
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
const TICKET_ID = "45dc8b15-43cb-4bb3-8f1f-088794acedda";
const CUSTOMER_ID = "82ca8e59-f063-4b6e-809d-484a1136079d";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const englishBody = `<p>Hi Maria,</p>
<p>Thanks for reaching out — I checked on both of your recent orders.</p>
<p><strong>Order SC129548 (placed May 3):</strong> this one was delivered. Tracking with DHL Smart Mail: <a href="https://webtrack.dhlglobalmail.com/?trackingnumber=9261290367770961414787">9261290367770961414787</a>. If you didn't see the package, it's worth checking with anyone in your household, your mailbox, and your neighbors — let me know if it's still missing.</p>
<p><strong>Order SC129756 (placed May 6):</strong> this one is still on the way via USPS. Tracking: <a href="https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=9261290378010201143425">9261290378010201143425</a>. It should arrive in the next few days.</p>
<p>If the May 3 package never shows up, just reply here and I'll get a replacement out to you right away.</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`;

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { translateIfNeeded } = await import("../src/lib/translate");

  console.log("\n▶ Translate body → Spanish via Haiku");
  const spanishBody = await translateIfNeeded(englishBody, "es", {
    workspaceId: W,
    ticketId: TICKET_ID,
  });
  console.log("--- TRANSLATED BODY ---");
  console.log(spanishBody);
  console.log("--- END BODY ---");

  if (!APPLY) {
    console.log("\n🔍 Dry run complete — re-run with --apply");
    return;
  }

  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name")
    .eq("id", CUSTOMER_ID)
    .single();
  if (!customer?.email) {
    console.log("✗ no customer email");
    return;
  }

  const { data: ticket } = await admin
    .from("tickets")
    .select("subject, email_message_id")
    .eq("id", TICKET_ID)
    .single();

  console.log(`\n▶ Send to ${customer.email}`);
  const { sendTicketReply } = await import("../src/lib/email");
  const result = await sendTicketReply({
    workspaceId: W,
    toEmail: customer.email,
    subject: ticket?.subject || "Sobre tu pedido",
    body: spanishBody,
    inReplyTo: ticket?.email_message_id || null,
    agentName: "Suzie",
    workspaceName: "Superfoods Company",
  });
  if (result.error) {
    console.log("  ✗", result.error);
    process.exit(1);
  }
  console.log(`  ✓ sent (resend ${result.messageId})`);

  await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body: spanishBody,
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
      subject: ticket?.subject || "Sobre tu pedido",
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
    });
  }

  await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] Operator Dylan: replied to Maria in Spanish — SC129548 delivered (DHL), SC129756 in transit (USPS). Body translated via translateIfNeeded(es).`,
  });

  await admin.from("tickets").update({
    status: "pending",
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET_ID);
  console.log("  ✓ ticket set to pending");

  console.log("\n✅ Done");
}

main().catch((e) => { console.error(e); process.exit(1); });
