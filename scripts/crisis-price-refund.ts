/**
 * crisis-price-refund — refund the renewals that actually BILLED at the price my crisis swap reset.
 *
 * `crisis-price-restore.ts` fixed the subscriptions going forward. Seven renewals had already
 * charged in between (2026-07-31), at catalog price instead of the customer's established rate.
 * That is real money taken, and correcting the sub does not give it back.
 *
 * WHY THIS LIST IS SIX AND NOT SEVEN
 * `chrisith@hotmail.com` already got exactly the right refund — Sol caught the overcharge when they
 * wrote in on 7/31 and refunded $23.98, the full difference. Re-refunding would double-pay. The
 * per-order netting below is what proves that, and it is derived from `order_refunds`, never
 * hardcoded.
 *
 * THE BASELINE, AND ONE CASE HELD BACK
 * Refunds are computed against the rate that SUBSCRIPTION last actually billed (its own renewal
 * history) — see the long note in `crisis-price-restore.ts`. Five of the six are unaffected by the
 * open 50%-MSRP-floor question because their established rates ($38.95–$54.95) sit above the
 * $39.98 floor either way. `heavensangel411@yahoo.com` is the exception: their true rate is
 * $29.95 but Sol remediated them to the floor and refunded on that basis, so whether a further
 * $40.12 is owed depends on a pricing-policy call that is the CEO's, not this script's. They are
 * EXCLUDED here and flagged in the output.
 *
 * Money-safety: goes through `executeSonnetDecision` → the `partial_refund` handler, which carries
 * the verify-by-refund-id idempotency guard (`order_refunds.request_key`), the double-refund guard,
 * the customer_events log and the Slack notification. Never calls Braintree/Shopify directly.
 * Re-running is safe — a second attempt short-circuits on the existing succeeded refund row.
 *
 *   npx tsx scripts/crisis-price-refund.ts            # dry run — shows every amount and its math
 *   npx tsx scripts/crisis-price-refund.ts --apply
 */
import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const SWAP_AT = "2026-07-30T00:00:00Z";
/**
 * A refund must be materially an overcharge. Mirrors the >= $1 AND >= 2% test
 * `subscription-overcharge` uses, and for the same reason: catalog prices drift by pennies
 * ($59.95 -> $59.96), and without a floor a one-cent rounding artifact reads as an overcharge.
 * That happened for real — lrb@bartelsplants.com was refunded $0.01 on 2026-08-02 and had a
 * "we overcharged you" ticket opened, on a subscription this crisis never touched.
 */
const MIN_REFUND_CENTS = 100;
const MIN_REFUND_PCT = 2;

const HOLD = new Set<string>(); // CEO 2026-08-01: honor each customer's real historical rate,
                               // not the 50%-MSRP floor — so heavensangel411 is owed the balance.

interface Row {
  email: string; customerId: string; orderId: string; orderNumber: string; shopifyOrderId: string | null;
  billedUnit: number; priorUnit: number; qty: number; alreadyRefunded: number; owed: number;
}

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");
  const c = pgClient(); await c.connect();
  let rows: Row[] = [];
  try {
    const { rows: r } = await c.query(`
      select cu.email, cu.id customer_id, o.id order_id, o.order_number, o.shopify_order_id,
             billed.unit billed_unit, billed.qty, prior.unit prior_unit,
             coalesce((select sum(amount_cents) from order_refunds rf
                       where rf.order_id = o.id and rf.status in ('succeeded','settled')), 0) refunded
      from orders o
      join subscriptions s on s.id = o.subscription_id
      join crisis_customer_actions a on a.subscription_id = s.id and a.restored_at is not null
      join customers cu on cu.id = o.customer_id
      cross join lateral (
        select (i->>'price_cents')::int unit, coalesce((i->>'quantity')::int,1) qty
        from jsonb_array_elements(o.line_items) i
        where i->>'sku' like 'SC-TABS%' and (i->>'price_cents')::int > 0 limit 1
      ) billed
      cross join lateral (
        select (i2->>'price_cents')::int unit
        from orders o2 cross join lateral jsonb_array_elements(o2.line_items) i2
        where o2.subscription_id = s.id and o2.created_at < $2
          and coalesce(o2.source_name,'') <> 'shopify_draft_order'
          and i2->>'sku' like 'SC-TABS%' and (i2->>'price_cents')::int > 0
        order by o2.created_at desc limit 1
      ) prior
      where o.workspace_id = $1 and o.created_at >= $2 and billed.unit > prior.unit
      order by cu.email`, [W, SWAP_AT]);

    rows = r.map((x: any) => {
      const over = (Number(x.billed_unit) - Number(x.prior_unit)) * Number(x.qty || 1);
      return {
        email: String(x.email), customerId: String(x.customer_id), orderId: String(x.order_id),
        orderNumber: String(x.order_number), shopifyOrderId: x.shopify_order_id ? String(x.shopify_order_id) : null,
        billedUnit: Number(x.billed_unit), priorUnit: Number(x.prior_unit), qty: Number(x.qty || 1),
        alreadyRefunded: Number(x.refunded),
        owed: (over >= MIN_REFUND_CENTS && (over * 100) / Math.max(1, Number(x.billed_unit) * Number(x.qty || 1)) >= MIN_REFUND_PCT)
          ? Math.max(0, over - Number(x.refunded))
          : 0,
      };
    });
  } finally { await c.end(); }

  console.log(`\nrenewals billed above the established rate since ${SWAP_AT.slice(0, 10)}: ${rows.length}\n`);
  const todo: Row[] = [];
  for (const r of rows) {
    const over = (r.billedUnit - r.priorUnit) * r.qty;
    const why = HOLD.has(r.email) ? "HELD — pending the 50%-floor decision"
      : r.owed === 0 && (r.billedUnit - r.priorUnit) * r.qty < MIN_REFUND_CENTS ? `below the $${(MIN_REFUND_CENTS / 100).toFixed(2)} materiality floor — rounding drift, not an overcharge`
      : r.owed === 0 ? "settled — already refunded in full"
      : "to refund";
    console.log(`  ${r.email.padEnd(32)} ${r.orderNumber.padEnd(10)} $${(r.billedUnit / 100).toFixed(2)}/u vs $${(r.priorUnit / 100).toFixed(2)}/u ×${r.qty}` +
      ` = $${(over / 100).toFixed(2)} over · refunded $${(r.alreadyRefunded / 100).toFixed(2)} → ${why}${r.owed && !HOLD.has(r.email) ? ` $${(r.owed / 100).toFixed(2)}` : ""}`);
    if (r.owed > 0 && !HOLD.has(r.email)) todo.push(r);
  }
  const total = todo.reduce((s, r) => s + r.owed, 0);
  console.log(`\nrefunding ${todo.length} customer(s), $${(total / 100).toFixed(2)} total`);

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply."); return; }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { executeSonnetDecision } = await import("../src/lib/action-executor");
  const admin = createAdminClient() as any;

  let ok = 0; const failed: string[] = [];
  for (const r of todo) {
    const amountStr = `$${(r.owed / 100).toFixed(2)}`;
    const reason = `Crisis-swap pricing correction — renewal ${r.orderNumber} billed $${(r.billedUnit / 100).toFixed(2)}/unit against an established rate of $${(r.priorUnit / 100).toFixed(2)}/unit; refunding the ${amountStr} difference`;

    // A ticket to hold the record and give the refund handler its idempotency scope.
    const { data: ticket, error: tErr } = await admin.from("tickets").insert({
      workspace_id: W, customer_id: r.customerId, channel: "email", status: "closed",
      subject: `Refund — ${r.orderNumber} billed above your subscriber rate`,
      tags: ["pricing", "crisis:mixed-berry", "overcharge-remediation"],
      ai_handled: false, closed_at: new Date().toISOString(), resolved_at: new Date().toISOString(),
    }).select("id").single();
    if (tErr) { failed.push(`${r.email}: ticket ${tErr.message}`); continue; }

    const decision = {
      reasoning: `Operator-triggered. The 2026-07-30 crisis variant swap reset this subscription's line price to catalog; renewal ${r.orderNumber} then billed at the reset price before the correction landed. Refunding the difference against the subscription's own established rate.`,
      action_type: "direct_action" as const,
      actions: [{ type: "partial_refund", shopify_order_id: r.shopifyOrderId ?? r.orderNumber, amount_cents: r.owed, reason }],
      response_message:
        `We charged you too much on your last order and I've refunded the difference — ${amountStr} is on its way back to your original payment method.\n\n` +
        `When we switched your Superfood Tabs during the Mixed Berry restock, the switch reset your subscription to our standard price instead of keeping the rate you've been paying. That was our mistake, not a price change.\n\n` +
        `Your subscription is back to $${(r.priorUnit / 100).toFixed(2)} per unit and your next order will bill at that rate.`,
    };

    const sendFn = async (msg: string) => {
      await admin.from("ticket_messages").insert({
        ticket_id: ticket.id, direction: "outbound", visibility: "internal", author_type: "ai",
        body: `[DRAFTED — not sent to the customer; awaiting CEO sign-off on notification copy]\n\n${msg}`,
      });
    };
    const sysNoteFn = async (msg: string) => {
      await admin.from("ticket_messages").insert({
        ticket_id: ticket.id, direction: "outbound", visibility: "internal", author_type: "system", body: msg,
      });
    };

    try {
      const result = await executeSonnetDecision(
        { admin, workspaceId: W, ticketId: ticket.id, customerId: r.customerId, channel: "email", sandbox: false },
        decision, null, sendFn, sysNoteFn,
      );
      // VERIFY: the refund handler reports through the action result, but the durable proof is a
      // succeeded row in the order_refunds mirror.
      const { data: rf } = await admin.from("order_refunds")
        .select("amount_cents, status").eq("workspace_id", W).eq("order_id", r.orderId)
        .in("status", ["succeeded", "settled"]);
      const totalRefunded = (rf || []).reduce((s: number, x: any) => s + Number(x.amount_cents || 0), 0);
      const landed = totalRefunded >= r.alreadyRefunded + r.owed;
      if (landed && !result.escalated) { ok++; console.log(`  ✓ ${r.email.padEnd(32)} ${amountStr}`); }
      else { failed.push(`${r.email}: escalated=${result.escalated} refunded-total $${(totalRefunded / 100).toFixed(2)}`); console.log(`  ✗ ${r.email} — did not land`); }
    } catch (e) {
      failed.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n✓ refunded ${ok}/${todo.length}`);
  if (failed.length) { console.log("✗ needs attention:"); for (const f of failed) console.log(`   ${f}`); }
  console.log("\nCustomer notification copy is DRAFTED on each ticket as an internal note, not sent.");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
