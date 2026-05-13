/**
 * Ticket 6d6423f3 (Viki Kincaid) — wrong flavor (Strawberry Lemonade
 * via crisis swap). She said "send the strawberry lemonade back and
 * wait for the mixed berry". Opus offered options + said it'd
 * "process the return right away" but nothing fired:
 *   - No return created
 *   - Sub still active (not paused)
 *   - auto_resume still false on crisis row
 *
 * This script: pause sub, set auto_resume=true (auto_readd already
 * true), create return for SC129485, send email with the real label.
 *
 *   npx tsx scripts/viki-fix.ts            # dry run
 *   npx tsx scripts/viki-fix.ts --apply    # do it
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
const TICKET_ID = "6d6423f3-a697-4ede-bfae-f7b2134b7f26";
const CUSTOMER_ID = "b5b8cb21-119c-4724-8775-5ba973808b6c";
const SUB_CONTRACT = "27834450093";
const ORDER_NUMBER = "SC129485";
const CRISIS_ACTION_ID = "82d2c1b7-eeec-465d-acca-53f9422bed1e";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  // Look up the order row to get the UUID + shopify_order_id
  const { data: order } = await admin
    .from("orders")
    .select("id, shopify_order_id, shipping_address")
    .eq("order_number", ORDER_NUMBER)
    .eq("workspace_id", W)
    .single();
  if (!order) { console.log(`✗ order ${ORDER_NUMBER} not found`); process.exit(1); }
  const ship = (order.shipping_address as Record<string, string> | null) || {};
  console.log(`\nOrder ${ORDER_NUMBER}: shopify=${order.shopify_order_id}`);
  console.log(`  ship: ${ship.address1}, ${ship.city}, ${ship.province_code} ${ship.zip}`);

  // 1. Pause sub
  console.log(`\n▶ Pause subscription ${SUB_CONTRACT}`);
  if (APPLY) {
    const { appstleSubscriptionAction } = await import("../src/lib/appstle");
    const r = await appstleSubscriptionAction(W, SUB_CONTRACT, "pause");
    if (!r.success) { console.log("  ✗", r.error); process.exit(1); }
    console.log("  ✓ paused");
  }

  // 2. Update crisis row: paused_at + auto_resume=true
  console.log(`\n▶ Update crisis_customer_actions → paused_at, auto_resume=true`);
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

  // 3. Create return
  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name, last_name, phone")
    .eq("id", CUSTOMER_ID)
    .single();
  const customerName = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email || "Customer";

  let labelUrl: string | undefined;
  let trackingNumber: string | undefined;
  let carrier: string | undefined;
  let returnId: string | undefined;

  console.log(`\n▶ Create full return for ${ORDER_NUMBER}`);
  if (APPLY) {
    const { createFullReturn } = await import("../src/lib/shopify-returns");
    const result = await createFullReturn({
      workspaceId: W,
      orderId: order.id,
      orderNumber: ORDER_NUMBER,
      shopifyOrderGid: `gid://shopify/Order/${order.shopify_order_id}`,
      customerId: CUSTOMER_ID,
      ticketId: TICKET_ID,
      customerName,
      customerPhone: (customer?.phone as string | undefined) || undefined,
      shippingAddress: {
        street1: ship.address1 || "",
        city: ship.city || "",
        state: ship.province_code || "",
        zip: ship.zip || "",
        country: ship.country_code || "US",
      },
      resolutionType: "refund_return",
      source: "ai",
      freeLabel: true,
    });
    if (!result.success) { console.log("  ✗", result.error); process.exit(1); }
    console.log(`  ✓ return ${result.returnId}`);
    console.log(`    tracking: ${result.trackingNumber}`);
    console.log(`    label:    ${result.labelUrl}`);
    returnId = result.returnId;
    labelUrl = result.labelUrl;
    trackingNumber = result.trackingNumber;
    carrier = result.carrier;
  }

  // 4. Send email
  const greeting = customer?.first_name ? `Hi ${customer.first_name},` : "Hi,";
  const body = `<p>${greeting}</p>
<p>Quick follow-up — your return is all set up. Here is the prepaid label for the Strawberry Lemonade order:</p>
<p><a href="${labelUrl || "{{label_url}}"}">Download your return label${carrier ? ` (${carrier})` : ""}</a></p>
${trackingNumber ? `<p><strong>Tracking:</strong> ${trackingNumber}</p>` : ""}
<p>Print the label, attach it to the package (the original box works fine), and drop it off at any ${carrier || "carrier"} location. Once we receive the package back, your <strong>full refund</strong> processes automatically — no shipping cost to you.</p>
<p>I have also paused your subscription, so you will not be billed again. You are on our list to be automatically switched back to Mixed Berry as soon as it is back in stock (expected July 9). You do not need to do anything — your next shipment after the restock will be Mixed Berry, exactly like you had it before.</p>
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
      subject: ticket?.subject || "Your return label + paused subscription",
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
        subject: ticket?.subject || "Your return label + paused subscription",
        ticketId: TICKET_ID,
        customerId: CUSTOMER_ID,
      });
    }

    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Operator Dylan: paused sub, set crisis auto_resume=true (auto_readd already true), created return ${returnId} for ${ORDER_NUMBER}, sent label email.`,
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
