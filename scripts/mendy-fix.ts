/**
 * Mendy Kauffman (ticket b0d46e97-7a5e-453c-9fbf-957750802771) recovery:
 *   1. Pause her active Superfood Tabs subscription
 *   2. Update her crisis_customer_actions row → paused_at + auto_resume=true
 *      so she's silently unpaused when Mixed Berry comes back
 *   3. Create a return for her most recent order (SC129741, May 6 — the
 *      Strawberry Lemonade swap shipment she wants to send back)
 *   4. Send her an email with the actual EasyPost label URL +
 *      confirmation of full refund (the prior AI message sent literal
 *      {{label_url}} placeholders)
 *
 *   Usage:
 *     npx tsx scripts/mendy-fix.ts           # dry run
 *     npx tsx scripts/mendy-fix.ts --apply   # do it
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
const TICKET_ID = "b0d46e97-7a5e-453c-9fbf-957750802771";
const CUSTOMER_ID = "2474cccd-2292-4618-b98a-8e9192fb3564";
const SUB_UUID = "e6c8b57e-2fa2-427d-ad75-99aa71f376d9";
const SUB_CONTRACT = "27805712557";
const ORDER_UUID = "0d145b8b-79e3-4470-844f-9956b35c8001";
const ORDER_NUMBER = "SC129741";
const SHOPIFY_ORDER_ID = "6918660030637";
const CRISIS_ACTION_ID = "0fc9b959-c8db-4dd0-8ddc-0a20431056bf";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  // 1. Pause the subscription
  console.log(`\n▶ Pause subscription ${SUB_CONTRACT}`);
  if (APPLY) {
    const { appstleSubscriptionAction } = await import("../src/lib/appstle");
    const r = await appstleSubscriptionAction(W, SUB_CONTRACT, "pause");
    if (!r.success) {
      console.log("  ✗", r.error);
      process.exit(1);
    }
    console.log("  ✓ paused");
  }

  // 2. Update crisis_customer_actions
  console.log(`\n▶ Update crisis_customer_actions ${CRISIS_ACTION_ID} → paused_at=now, auto_resume=true`);
  if (APPLY) {
    const { error } = await admin
      .from("crisis_customer_actions")
      .update({
        paused_at: new Date().toISOString(),
        auto_resume: true,
        ticket_id: TICKET_ID,
        updated_at: new Date().toISOString(),
      })
      .eq("id", CRISIS_ACTION_ID);
    if (error) { console.log("  ✗", error.message); process.exit(1); }
    console.log("  ✓ crisis action updated");
  }

  // 3. Confirm no existing return for this order
  const { data: existing } = await admin
    .from("returns")
    .select("id, status, label_url")
    .eq("workspace_id", W)
    .eq("order_id", ORDER_UUID);
  if (existing?.length) {
    console.log(`\n⚠ ${existing.length} existing return(s) for this order:`);
    for (const r of existing) console.log(`  ${r.id} status=${r.status} label=${r.label_url ? "yes" : "no"}`);
  } else {
    console.log("\n✓ No existing return for SC129741");
  }

  // 4. Pull order's shipping address + customer for createFullReturn
  const { data: order } = await admin
    .from("orders")
    .select("shipping_address")
    .eq("id", ORDER_UUID)
    .single();
  const ship = (order?.shipping_address as Record<string, string> | null) || {};
  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name, last_name, phone")
    .eq("id", CUSTOMER_ID)
    .single();
  const customerName = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email || "Customer";

  console.log(`\n▶ Create full return for ${ORDER_NUMBER} (${SHOPIFY_ORDER_ID})`);
  console.log(`  ship_from: ${ship.address1}, ${ship.city}, ${ship.province_code} ${ship.zip}`);
  console.log(`  customer: ${customerName} <${customer?.email}>`);

  let labelUrl: string | undefined;
  let trackingNumber: string | undefined;
  let carrier: string | undefined;
  let returnId: string | undefined;

  if (APPLY) {
    const { createFullReturn } = await import("../src/lib/shopify-returns");
    const result = await createFullReturn({
      workspaceId: W,
      orderId: ORDER_UUID,
      orderNumber: ORDER_NUMBER,
      shopifyOrderGid: `gid://shopify/Order/${SHOPIFY_ORDER_ID}`,
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
      freeLabel: true, // crisis return — full refund, no label deduction
    });
    if (!result.success) {
      console.log("  ✗", result.error);
      process.exit(1);
    }
    console.log(`  ✓ return created: ${result.returnId}`);
    console.log(`    tracking: ${result.trackingNumber}`);
    console.log(`    carrier:  ${result.carrier}`);
    console.log(`    label:    ${result.labelUrl}`);
    returnId = result.returnId;
    labelUrl = result.labelUrl;
    trackingNumber = result.trackingNumber;
    carrier = result.carrier;
  } else {
    console.log("  (skipping creation in dry-run)");
  }

  // 5. Send email with real label + full refund commitment
  const greeting = customer?.first_name ? `Hi ${customer.first_name},` : "Hi,";
  const body = `<p>${greeting}</p>
<p>Apologies for the broken link earlier — that message went out with template placeholders instead of the actual return label. Here it is for real this time.</p>
<p><strong>Your prepaid return label:</strong></p>
<p><a href="${labelUrl || "{{label_url}}"}">Download your return label${carrier ? ` (${carrier})` : ""}</a></p>
${trackingNumber ? `<p><strong>Tracking:</strong> ${trackingNumber}</p>` : ""}
<p>Print the label, attach it to the package (the original box works fine), and drop it off at any ${carrier || "carrier"} location. Once we receive the Strawberry Lemonade Tabs back, your <strong>full refund</strong> goes through automatically — no shipping cost to you.</p>
<p>I've also paused your subscription, so you won't be billed again. We've added you to the list to be silently switched back to <strong>Mixed Berry</strong> as soon as it's back in stock (currently expected in July). You don't need to do anything — your next shipment after the restock will just be the original Mixed Berry.</p>
<p>Thanks for sticking with us, Mendy — really sorry for the back-and-forth.</p>
<p>— Suzie, Customer Support at Superfoods Company</p>`;

  console.log(`\n▶ Send email reply to ${customer?.email}`);
  if (APPLY) {
    const { sendTicketReply } = await import("../src/lib/email");
    const { data: t } = await admin
      .from("tickets")
      .select("subject, email_message_id")
      .eq("id", TICKET_ID)
      .single();
    const result = await sendTicketReply({
      workspaceId: W,
      toEmail: customer!.email!,
      subject: t?.subject || "Your return label",
      body,
      inReplyTo: t?.email_message_id || null,
      agentName: "Suzie",
      workspaceName: "Superfoods Company",
    });
    if (result.error) { console.log("  ✗", result.error); process.exit(1); }
    console.log(`  ✓ sent (resend ${result.messageId})`);

    // Ticket message row
    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "external",
      author_type: "ai",
      body,
      sent_at: new Date().toISOString(),
      resend_email_id: result.messageId || null,
      email_status: result.messageId ? "sent" : null,
      email_message_id: result.messageId ? `<${result.messageId}@resend.dev>` : null,
    });

    // Email tracking
    if (result.messageId) {
      const { logEmailSent } = await import("../src/lib/email-tracking");
      await logEmailSent({
        workspaceId: W,
        resendEmailId: result.messageId,
        recipientEmail: customer!.email!,
        subject: t?.subject || "Your return label",
        ticketId: TICKET_ID,
        customerId: CUSTOMER_ID,
      });
    }

    // Internal note
    await admin.from("ticket_messages").insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] Operator Dylan: paused subscription, set crisis auto_resume=true, created return ${returnId || "?"} for ${ORDER_NUMBER}, and re-sent the label (carrier ${carrier}, tracking ${trackingNumber}). Prior AI message had {{label_url}} as a literal placeholder.`,
    });

    // Close the ticket
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
