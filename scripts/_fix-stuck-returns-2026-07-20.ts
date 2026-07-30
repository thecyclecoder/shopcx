/**
 * One-off remedy — the two customers left short by the silent return-refund failures found
 * 2026-07-20 (founder-authorized same day). Each is repaired to the shape the rail expects, then
 * re-driven through the sanctioned `returns/issue-refund` event; `refundOrder`'s request_key guard
 * means the money can only move once even if this is run twice.
 *
 *  SC131156 ($68.51, delivered 2026-06-09) — returns.order_id is NULL, so refundOrder rejected it
 *    outright ("orderId is required"). Shopify: one $68.51 sale, no refunds → full amount owed.
 *    Fix: resolve order_id from shopify_order_gid, then re-drive.
 *
 *  SC129432 ($82.30 stored, delivered 2026-06-06) — two $6.95 refunds landed 2026-05-04, so only
 *    $68.40 is still refundable; the stored contract over-fires and Shopify refuses it. Fix: cap
 *    net_refund_cents to the live refundable balance (13984-style cap, NOT a re-derive from line
 *    items — see docs/brain/tables/returns.md:99), then re-drive. Customer nets $13.90 + $68.40 =
 *    the full $82.30.
 *
 *  SC130193 ($133.62, delivered 2026-05-26) — NO MONEY IS OWED. Shopify already shows a full
 *    $133.62 refund on the delivery date; only our row was never stamped. Fix: stamp it refunded so
 *    it stops reading as a debt (and so any future sweep can't double-refund it). No refund fired.
 *
 * Idempotent + dry-run by default; pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";
import { inngest } from "../src/lib/inngest/client";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const log = (s: string) => console.log(s);

async function main() {
  const admin = createAdminClient();

  const load = async (orderNumber: string) => {
    const { data, error } = await admin
      .from("returns")
      .select("id, order_number, order_id, shopify_order_gid, status, net_refund_cents, refund_id, refunded_at")
      .eq("workspace_id", WS)
      .eq("order_number", orderNumber)
      .maybeSingle();
    if (error) throw new Error(`${orderNumber} lookup failed: ${error.message}`);
    if (!data) throw new Error(`${orderNumber} return not found`);
    return data as Record<string, unknown>;
  };

  // ── SC131156 — null order_id ───────────────────────────────────────────────
  const a = await load("SC131156");
  log(`\nSC131156: order_id=${a.order_id} net=${a.net_refund_cents} refunded_at=${a.refunded_at}`);
  if (a.refunded_at || a.refund_id) {
    log("  already refunded — skipping.");
  } else {
    const sid = String(a.shopify_order_gid).split("/").pop();
    const { data: ord } = await admin.from("orders").select("id").eq("workspace_id", WS).eq("shopify_order_id", sid).maybeSingle();
    if (!ord) throw new Error("SC131156: could not resolve order by shopify id");
    log(`  ${APPLY ? "SET" : "would set"} order_id -> ${ord.id}, then fire returns/issue-refund ($${(Number(a.net_refund_cents) / 100).toFixed(2)})`);
    if (APPLY) {
      const { error } = await admin.from("returns").update({ order_id: ord.id, updated_at: new Date().toISOString() }).eq("id", a.id as string).eq("workspace_id", WS);
      if (error) throw new Error(`SC131156 order_id update failed: ${error.message}`);
      await inngest.send({ name: "returns/issue-refund", data: { workspace_id: WS, return_id: a.id } });
      log("  fired.");
    }
  }

  // ── SC129432 — contract exceeds the live refundable balance ────────────────
  const b = await load("SC129432");
  const CAP = 6840;
  log(`\nSC129432: net=${b.net_refund_cents} refunded_at=${b.refunded_at}`);
  if (b.refunded_at || b.refund_id) {
    log("  already refunded — skipping.");
  } else {
    log(`  ${APPLY ? "CAP" : "would cap"} net_refund_cents ${b.net_refund_cents} -> ${CAP}, then fire returns/issue-refund ($68.40)`);
    if (APPLY) {
      const { error } = await admin.from("returns").update({ net_refund_cents: CAP, updated_at: new Date().toISOString() }).eq("id", b.id as string).eq("workspace_id", WS);
      if (error) throw new Error(`SC129432 cap failed: ${error.message}`);
      await inngest.send({ name: "returns/issue-refund", data: { workspace_id: WS, return_id: b.id } });
      log("  fired.");
    }
  }

  // ── SC130193 — money already moved out of band; stamp only, NEVER refund ───
  const c = await load("SC130193");
  log(`\nSC130193: status=${c.status} refunded_at=${c.refunded_at} (Shopify already refunded $133.62 on 2026-05-26)`);
  if (c.refunded_at || c.refund_id) {
    log("  already stamped — skipping.");
  } else {
    log(`  ${APPLY ? "STAMP" : "would stamp"} refunded (refund_id='out_of_band_shopify'). NO refund fired — money already moved.`);
    if (APPLY) {
      const { error } = await admin
        .from("returns")
        .update({ status: "refunded", refund_id: "out_of_band_shopify", refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", c.id as string)
        .eq("workspace_id", WS)
        .is("refunded_at", null);
      if (error) throw new Error(`SC130193 stamp failed: ${error.message}`);
      log("  stamped.");
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
