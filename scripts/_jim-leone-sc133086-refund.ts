/**
 * One-off remedy — Jim Leone (jleone@earthlink.net), ticket 5ed394f3, return 36a20358 (SC133086).
 *
 * SC133086 was charged $229.26 on 2026-06-20. On 2026-06-21 a $89.42 grandfathered-pricing
 * overcharge refund was issued DIRECTLY in Shopify (note: "$229.26 billed vs $139.84
 * grandfathered") — it never mirrored into public.order_refunds. On 2026-06-29 a full MBG return
 * was opened and stamped net_refund_cents=22926 (the PRE-correction order total), delivered back
 * 2026-07-03. returns/issue-refund then fired $229.26 at an order with only $139.84 refundable,
 * Shopify refused, and refunded_at stayed NULL — which is what June escalated as a "contradictory
 * ledger state" (she has no Shopify-refund-ledger read tool).
 *
 * This corrects net_refund_cents to the real remaining balance (13984) and re-fires the sanctioned
 * returns/issue-refund rail, which issues the refund through refundOrder (request-key idempotent),
 * writes the order_refunds mirror row, closes the Shopify return, and stamps refunded_at.
 *
 * Idempotent: bails if refund_id is already set. Dry-run by default; pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";
import { inngest } from "../src/lib/inngest/client";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RETURN_ID = "36a20358-fb17-4b8a-82be-5e9bf27d18de";
const CORRECTED_CENTS = 13984;
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const { data: ret, error } = await admin
    .from("returns")
    .select("id, order_number, status, net_refund_cents, refund_id, refunded_at, order_id")
    .eq("id", RETURN_ID)
    .eq("workspace_id", WS)
    .maybeSingle();
  if (error) throw new Error(`return lookup failed: ${error.message}`);
  if (!ret) throw new Error("return not found");

  console.log(`return ${ret.order_number}: status=${ret.status} net_refund_cents=${ret.net_refund_cents} refund_id=${ret.refund_id} refunded_at=${ret.refunded_at}`);
  if (ret.refund_id || ret.refunded_at) {
    console.log("ALREADY REFUNDED — nothing to do.");
    return;
  }
  if (ret.net_refund_cents === CORRECTED_CENTS) {
    console.log("net_refund_cents already corrected.");
  } else {
    console.log(`${APPLY ? "UPDATE" : "would update"} net_refund_cents ${ret.net_refund_cents} -> ${CORRECTED_CENTS}`);
    if (APPLY) {
      const { error: ue } = await admin
        .from("returns")
        .update({ net_refund_cents: CORRECTED_CENTS, updated_at: new Date().toISOString() })
        .eq("id", RETURN_ID)
        .eq("workspace_id", WS);
      if (ue) throw new Error(`net_refund_cents update failed: ${ue.message}`);
    }
  }

  console.log(`${APPLY ? "SEND" : "would send"} returns/issue-refund { workspace_id, return_id: ${RETURN_ID} }`);
  if (APPLY) {
    await inngest.send({ name: "returns/issue-refund", data: { workspace_id: WS, return_id: RETURN_ID } });
    console.log("event sent.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
