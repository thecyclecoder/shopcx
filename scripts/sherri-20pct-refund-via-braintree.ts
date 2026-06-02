/**
 * Sherri White (ticket 0f398055). The Sonnet/Opus path tried a
 * partial_refund on SC131028 and got "Sale transaction has no
 * Braintree authorization id" — Appstle subscription renewals
 * sometimes don't expose Braintree's transaction id on the
 * Shopify transaction row, which breaks our direct-Braintree
 * refund path.
 *
 * Recovery: find the matching Braintree transaction by searching
 * the gateway with customerEmail + amount + processedAt, refund
 * $22.05 directly, then record a manual refund on Shopify so the
 * order's financial status reflects the refund.
 *
 * 20% of $110.23 = $22.046 → $22.05 (the same number the
 * orchestrator computed).
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "0f398055-8d65-4e0c-a8ae-dae85d5d9c5e";
const ORDER_ID = "6954854744237";   // SC131028
const ORDER_TOTAL = "110.23";
const ORDER_DATE = "2026-05-24";    // for the date window on BT search
const REFUND_CENTS = 2205;
const EMAIL = "sherriwhite10@charter.net";
const REASON = "20% off — out-of-stock substitution (Strawberry Lemonade for Mixed Berry)";

async function main() {
  const { getBraintreeGateway } = await import("../src/lib/integrations/braintree");
  const { refundBraintreeTransaction } = await import("../src/lib/integrations/braintree");
  const { recordManualRefund } = await import("../src/lib/shopify-order-actions");

  const gateway = await getBraintreeGateway(WS);

  // Search Braintree for the matching transaction. We bracket the
  // processed-at to the order's day in UTC and filter by amount +
  // customer email. The BT search API uses a builder-style closure.
  const start = new Date(`${ORDER_DATE}T00:00:00Z`);
  const end = new Date(`${ORDER_DATE}T23:59:59Z`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: any[] = await new Promise((resolveP, rejectP) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: any = gateway.transaction.search((s: any) => {
      s.customerEmail().is(EMAIL);
      s.amount().is(ORDER_TOTAL);
      s.createdAt().between(start, end);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = [];
    stream.on("data", (t: unknown) => out.push(t));
    stream.on("end", () => resolveP(out));
    stream.on("error", (e: Error) => rejectP(e));
  });

  console.log(`found ${candidates.length} candidate BT transaction(s)`);
  for (const t of candidates) {
    console.log(`  id=${t.id} amount=$${t.amount} status=${t.status} processedAt=${t.createdAt}`);
  }

  if (candidates.length === 0) {
    throw new Error("no Braintree transaction matched email + amount + date — refund via Shopify admin UI manually");
  }

  // Pick the first settled / submitted transaction
  const tx = candidates.find((t) =>
    ["settled", "settling", "submitted_for_settlement"].includes(t.status)
  ) || candidates[0];
  console.log(`\n→ refunding tx ${tx.id} for $${(REFUND_CENTS / 100).toFixed(2)}`);

  const refundRes = await refundBraintreeTransaction(WS, tx.id, REFUND_CENTS);
  console.log("  refund result:", refundRes);
  if (!refundRes.success) throw new Error(`Braintree refund failed: ${refundRes.error}`);

  // Record on Shopify so the order's financial status updates
  const note = `${REASON} — Braintree refund txn ${refundRes.refundId || tx.id}`;
  console.log(`\n→ recording manual refund on Shopify order ${ORDER_ID}`);
  const rec = await recordManualRefund(WS, ORDER_ID, REFUND_CENTS, note);
  console.log("  shopify record:", rec);

  // Confirmation email — threads into the existing Gmail conversation
  // via the standard pending_send_at delay.
  const body = `<p>Hi Sherri — done. I just issued a <strong>20% refund of $22.05</strong> against order SC131028 to cover the Strawberry Lemonade substitution. You'll see it land on your card in 5–10 business days.</p><p>Your subscription is still set to automatically switch back to Mixed Berry the moment it's back in stock (expected July 9). I really appreciate your patience here.</p><p>Suzie, Customer Support at Superfoods Company</p>`;
  const pendingAt = new Date(Date.now() + 5_000).toISOString();
  const { data: msg } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "external",
    author_type: "agent",
    body,
    pending_send_at: pendingAt,
  }).select("id").single();
  await admin.from("tickets").update({
    status: "open",
    escalated: false,
    escalation_reason: null,
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET_ID);
  console.log(`\n✓ queued confirmation message ${msg?.id}, sending at ${pendingAt}`);
}

main().catch(e => { console.error("✗", e); process.exit(1); });
