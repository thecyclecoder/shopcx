/**
 * crisis-price-notify — tell the customers we overcharged what happened.
 *
 * `crisis-price-refund.ts` moved the money and drafted the explanation as an internal note; this
 * sends it. CEO approved 2026-08-01. Without it a customer just sees an unexplained refund land.
 *
 * WHO IS EXCLUDED, AND WHY THAT MATTERS
 * - A customer whose refund did NOT actually land is skipped. `r.aycock@comcast.net`'s partial
 *   refund escalated (Braintree can't partially refund an unsettled transaction), so telling them
 *   "$15.01 is on its way" would be a false statement. Eligibility is re-derived from a succeeded
 *   `order_refunds` row at send time, never from the earlier run's output — if the refund lands
 *   later, re-running this picks them up.
 * - A customer already told is skipped (idempotency): the send stamps the ticket, and a ticket that
 *   already carries an external outbound message is left alone.
 *
 * MARY GETS DIFFERENT COPY. Sol already emailed heavensangel411@yahoo.com on 7/31 saying she was
 * refunded $79.92 and "locked in" at $39.98. That was Sol applying the 50%-MSRP floor. The CEO's
 * call was to honour each customer's real historical rate instead ($29.95 for her), so she has a
 * second refund and a LOWER price than she was just promised. Sending her the standard copy would
 * read as a contradiction of a message she has in her inbox, so hers names the earlier one.
 *
 * Voice per [[../docs/brain/customer-voice]]: plain text, ≤2 sentences a paragraph, signed Suzie.
 * The apology is deliberate — this was our error, not a customer action (§ What NOT to apologize for
 * governs the reflexive case, not a real mistake on our side).
 *
 *   npx tsx scripts/crisis-price-notify.ts            # dry run — prints every message in full
 *   npx tsx scripts/crisis-price-notify.ts --apply
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
/** Same materiality floor as crisis-price-refund.ts — never send a "we overcharged you" apology
 *  for a rounding artifact. lrb@bartelsplants.com was refunded $0.01 on a $59.95 -> $59.96 catalog
 *  drift; emailing them about it would be both wrong and embarrassing. */
const MIN_NOTIFY_CENTS = 100;

const SIGNOFF = "Suzie, Customer Support at Superfoods Company";

function standardBody(first: string | null, amount: string, rate: string) {
  return [
    `${first ? `Hi ${first},` : "Hi there,"}`,
    `We charged you too much on your last order, and I've refunded the difference. ${amount} is on its way back to your original payment method and typically lands within 5 to 10 business days.`,
    `When we switched your Superfood Tabs during the Mixed Berry restock, the switch reset your subscription to our standard price instead of keeping the rate you've been paying. That was our mistake, not a price change.`,
    `Your subscription is back to ${rate} per unit, and your next order will bill at that rate. There's nothing you need to do.`,
    SIGNOFF,
  ].join("\n\n");
}

function maryBody(first: string | null, amount: string, rate: string) {
  return [
    `${first ? `Hi ${first},` : "Hi there,"}`,
    `I'm following up on the refund we sent you on Friday, because we got part of it wrong in your favor and I want to correct it properly.`,
    `We told you your locked rate was $39.98 per unit. Looking at your actual order history, you'd been paying ${rate} per unit, which is lower. So we owed you more than we refunded.`,
    `I've sent a further ${amount} back to your original payment method, and your subscription is now set to ${rate} per unit going forward. That's the rate you were on before any of this, and it's what your next order will bill at.`,
    `Sorry for the back and forth on it. The original mix-up came from the Mixed Berry restock resetting your subscription price, and it was ours to catch.`,
    SIGNOFF,
  ].join("\n\n");
}

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient() as any;

  const { data: tickets } = await admin.from("tickets")
    .select("id, customer_id, subject, created_at")
    .eq("workspace_id", W).contains("tags", ["overcharge-remediation"])
    .order("created_at", { ascending: true });

  let sent = 0, skipped = 0;
  const notified = new Set<string>();
  for (const t of tickets || []) {
    const { data: cust } = await admin.from("customers").select("email, first_name").eq("id", t.customer_id).maybeSingle();
    if (!cust?.email) { skipped++; continue; }

    // Already told? Scoped to the CUSTOMER, not the ticket. A customer can have more than one
    // remediation ticket (a failed refund attempt leaves one behind, and the retry opens another) —
    // per-ticket idempotency sent r.aycock@comcast.net the same email twice on 2026-08-02.
    if (notified.has(String(t.customer_id))) { console.log(`  · ${cust.email} — already notified, skipping`); skipped++; continue; }
    const { data: priorTickets } = await admin.from("tickets")
      .select("id").eq("workspace_id", W).eq("customer_id", t.customer_id).contains("tags", ["overcharge-remediation"]);
    const ids = (priorTickets || []).map((x: any) => x.id);
    const { data: already } = ids.length ? await admin.from("ticket_messages")
      .select("id").in("ticket_id", ids).eq("visibility", "external").eq("direction", "outbound").limit(1).maybeSingle() : { data: null };
    if (already) { console.log(`  · ${cust.email} — already notified, skipping`); skipped++; continue; }

    // The refund must actually have landed. Re-derived, never assumed.
    const orderNumber = String(t.subject).replace(/^Refund — /, "").replace(/ billed.*$/, "");
    const { data: ord } = await admin.from("orders").select("id").eq("workspace_id", W).eq("order_number", orderNumber).maybeSingle();
    const { data: refunds } = ord ? await admin.from("order_refunds")
      .select("amount_cents, created_at").eq("workspace_id", W).eq("order_id", ord.id)
      .in("status", ["succeeded", "settled"]).order("created_at", { ascending: false }) : { data: [] };
    const mine = (refunds || []).filter((r: any) => new Date(r.created_at) >= new Date("2026-08-01T00:00:00Z"));
    if (!mine.length) { console.log(`  ⚠ ${cust.email} — no refund landed for ${orderNumber}, NOT notifying`); skipped++; continue; }

    const amountCents = mine.reduce((s: number, r: any) => s + Number(r.amount_cents || 0), 0);
    if (amountCents < MIN_NOTIFY_CENTS) {
      console.log(`  · ${cust.email} — $${(amountCents / 100).toFixed(2)} is below the materiality floor, NOT notifying`);
      skipped++; continue;
    }
    const amount = `$${(amountCents / 100).toFixed(2)}`;

    // Their restored per-unit rate, read live off the sub.
    const { data: sub } = await admin.from("subscriptions")
      .select("items, is_internal, pricing_offer_id").eq("customer_id", t.customer_id)
      .in("status", ["active", "paused"]).limit(1).maybeSingle();
    let rateCents = 0;
    if (sub?.is_internal) {
      const { resolveSubscriptionPricing } = await import("../src/lib/pricing");
      const p = await resolveSubscriptionPricing(W, { items: sub.items, pricing_offer_id: sub.pricing_offer_id });
      rateCents = Number((p.lines || []).find((l: any) => !l.is_gift && String(l.sku || "").startsWith("SC-TABS"))?.unit_cents ?? 0);
    } else {
      rateCents = Math.max(...((sub?.items || []) as any[]).filter(i => String(i.sku || "").startsWith("SC-TABS")).map(i => Number(i.price_cents || 0)), 0);
    }
    if (!rateCents) { console.log(`  ⚠ ${cust.email} — couldn't read restored rate, NOT notifying`); skipped++; continue; }
    const rate = `$${(rateCents / 100).toFixed(2)}`;

    const isMary = cust.email === "heavensangel411@yahoo.com";
    const text = isMary ? maryBody(cust.first_name, amount, rate) : standardBody(cust.first_name, amount, rate);
    const subject = isMary ? "Correcting your refund — you were owed more" : "We overcharged you — refund sent";

    if (!APPLY) {
      console.log(`\n──────── ${cust.email}${isMary ? "  [custom copy]" : ""}`);
      console.log(`subject: ${subject}\n`);
      console.log(text);
      sent++;
      continue;
    }

    const { sendTicketReply } = await import("../src/lib/email");
    try {
      const html = text.split("\n\n").map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("\n");
      const res = await sendTicketReply({
        workspaceId: W, toEmail: cust.email, subject, body: html,
        inReplyTo: null, agentName: "Suzie", workspaceName: "Superfoods Company",
      });
      if (res.error) { console.log(`  ✗ ${cust.email}: ${res.error}`); skipped++; continue; }

      // Record it on the ticket and anchor threading, so a reply finds its way back here
      // (the same anchoring /api/tickets does — see scripts/_campaign-send.ts).
      const emailMessageId = `<${res.messageId}@resend.dev>`;
      await admin.from("ticket_messages").insert({
        ticket_id: t.id, direction: "outbound", visibility: "external", author_type: "ai",
        body: html, sent_at: new Date().toISOString(),
        resend_email_id: res.messageId, email_status: "sent", email_message_id: emailMessageId,
      });
      await admin.from("tickets").update({ email_message_id: emailMessageId }).eq("id", t.id);
      notified.add(String(t.customer_id));
      console.log(`  ✓ ${cust.email} — ${amount}, rate ${rate}`);
      sent++;
    } catch (e) {
      console.log(`  ✗ ${cust.email}: ${e instanceof Error ? e.message : String(e)}`);
      skipped++;
    }
  }
  console.log(`\n${APPLY ? "sent" : "would send"} ${sent} · skipped ${skipped}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
