/**
 * Ticket 8e9e325e — Harvey Kletz. He claimed he never got his "10% + 15%"
 * discounts on storefront order SHOPCX19. Investigation:
 *   - He DID get the 15% (WELCOME-P2RJD, -$11.99) — it auto-applied at
 *     checkout; it's in orders.payment_details (the orders.discount_codes
 *     column is empty, a storefront sync gap, which is why the AI couldn't
 *     see it and wrongly agreed to refund 25%).
 *   - There is no 10% on a 1-unit order (qty-1 break = 0%).
 *
 * Per Dylan (2026-06-20): show Harvey the breakdown proving he got the 15%,
 * AND issue a goodwill 10% partial refund ($7.99 = 10% of the $79.95 product)
 * and tell him. Braintree-native order (no shopify_order_id) → refund the
 * Braintree txn directly.
 *
 * Idempotent: refund guarded by a ticket sentinel. Dry-run by default; --apply.
 */
import { createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "8e9e325e-40f4-4554-8bf9-be55c47dcc4d";
const TO = "hkletz@aol.com";
const SUBJECT = "Re: My order";
const BT_TXN = "kd7ynepe";
const REFUND_CENTS = 799; // 10% of $79.95 product subtotal
const SENTINEL = `[Remedy 8e9e325e] goodwill 10% refund ${REFUND_CENTS}c applied`;
const APPLY = process.argv.includes("--apply");

const body = [
  "<p>Hi Harvey,</p>",
  "<p>Good news — you actually did receive your 15% discount. Here's exactly how your order broke down:</p>",
  "<p>Amazing Coffee (Cocoa French Roast): $79.95<br>" +
    "15% welcome discount (WELCOME-P2RJD): −$11.99<br>" +
    "Shipping: $5.95<br>" +
    "Shipping protection: $4.95<br>" +
    "Tax: $7.48<br>" +
    "<strong>Total: $86.34</strong></p>",
  "<p>That 15% came off your coffee right at checkout. On top of that, I've gone ahead and applied an additional 10% back to your original payment — $7.99 — which you'll see within a few business days.</p>",
  "<p>Thanks for your patience, Harvey, and enjoy the Cocoa coffee!</p>",
  "<p>Suzie, Customer Support at Superfoods Company</p>",
].join("");

async function main() {
  const admin = createAdminClient();
  console.log(`=== Harvey refund + close (8e9e325e) — ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  console.log("Refund: $" + (REFUND_CENTS / 100).toFixed(2) + " on Braintree txn " + BT_TXN);
  console.log("\nBody:\n" + body.replace(/<\/p>/g, "\n").replace(/<br>/g, "\n").replace(/<[^>]+>/g, ""));

  // Idempotency
  const { data: prior } = await admin.from("ticket_messages")
    .select("id").eq("ticket_id", TICKET).ilike("body", `%${SENTINEL}%`).limit(1);
  const alreadyRefunded = (prior?.length ?? 0) > 0;
  console.log("\nIdempotency:", alreadyRefunded ? "sentinel FOUND — will skip refund" : "no sentinel — refund will run");

  if (!APPLY) { console.log("\n--- DRY RUN --- re-run with --apply."); return; }

  // Step 1: 10% Braintree refund
  if (alreadyRefunded) {
    console.log("\nSTEP 1 — SKIPPED (already refunded).");
  } else {
    console.log("\nSTEP 1 — Braintree refund $" + (REFUND_CENTS / 100).toFixed(2) + "…");
    const { refundBraintreeTransaction } = await import("../src/lib/integrations/braintree");
    const r = await refundBraintreeTransaction(WS, BT_TXN, REFUND_CENTS);
    console.log("  ->", JSON.stringify(r));
    if (!r.success) {
      console.log("  REFUND FAILED — NOT sending the message (it claims a refund). " +
        "If 'not settled', retry once the Braintree txn settles. Aborting.");
      return;
    }
    await admin.from("ticket_messages").insert({
      ticket_id: TICKET, workspace_id: WS, direction: "outbound", visibility: "internal", author_type: "system",
      body: `${SENTINEL} (braintree refund ${r.refundId ?? "?"}) — goodwill 10% on SHOPCX19; customer already received the 15% WELCOME-P2RJD discount.`,
    });
    console.log("  sentinel written.");
  }

  // Step 2: send the breakdown + refund confirmation
  const { data: lastIn } = await admin.from("ticket_messages")
    .select("email_message_id").eq("ticket_id", TICKET).eq("direction", "inbound")
    .not("email_message_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const inReplyTo = lastIn?.email_message_id || null;

  const { sendTicketReply } = await import("../src/lib/email");
  const { messageId, error } = await sendTicketReply({
    workspaceId: WS, toEmail: TO, subject: SUBJECT, body,
    inReplyTo, agentName: "Suzie", workspaceName: "Superfoods Company",
  });
  if (error || !messageId) throw new Error(`send failed: ${error}`);
  console.log("\nSTEP 2 — ✓ sent, resend id:", messageId);

  await admin.from("ticket_messages").insert({
    ticket_id: TICKET, workspace_id: WS, direction: "outbound", visibility: "external", author_type: "agent",
    body, resend_email_id: messageId, sent_at: new Date().toISOString(),
  });

  await admin.from("tickets").update({
    escalated_to: null, escalated_at: null, escalation_reason: null,
    assigned_to: null, status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", TICKET);
  console.log("  ✓ message persisted; ticket unescalated + closed");
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", e); process.exit(1); });
