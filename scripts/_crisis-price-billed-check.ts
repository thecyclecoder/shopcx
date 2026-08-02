/**
 * Did anyone actually get BILLED at the price my crisis swap reset?
 *
 * The swap ran 2026-07-30 and reset ~274 subs to catalog price. Correcting the subscription only
 * fixes it going forward — any renewal that CHARGED between the swap and the correction is real
 * money owed back. Read-only; prints the refund list.
 */
import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SWAP_AT = "2026-07-30T00:00:00Z";

async function main() {
  const c = pgClient(); await c.connect();
  try {
    const { rows } = await c.query(`
      select cu.email, o.order_number, o.created_at, o.total_cents, o.financial_status,
             billed.unit billed_unit, billed.qty,
             prior.unit prior_unit
      from orders o
      join subscriptions s on s.id = o.subscription_id
      join crisis_customer_actions a on a.subscription_id = s.id and a.restored_at is not null
      join customers cu on cu.id = o.customer_id
      cross join lateral (
        select (i->>'price_cents')::int unit, (i->>'quantity')::int qty
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
      where o.workspace_id = $1 and o.created_at >= $2
        and billed.unit > prior.unit
      order by (billed.unit - prior.unit) * billed.qty desc`, [W, SWAP_AT]);

    if (!rows.length) { console.log("✓ No renewal billed above its prior rate since the swap. Nothing to refund."); return; }
    let owed = 0;
    console.log(`⚠️  ${rows.length} renewal(s) billed above the customer's established rate since ${SWAP_AT.slice(0, 10)}:\n`);
    for (const r of rows) {
      const over = (Number(r.billed_unit) - Number(r.prior_unit)) * Number(r.qty || 1);
      owed += over;
      console.log(`  ${String(r.email).padEnd(32)} ${r.order_number}  ${String(r.created_at).slice(0, 10)}  ` +
        `$${(r.billed_unit / 100).toFixed(2)}/u vs $${(r.prior_unit / 100).toFixed(2)}/u ×${r.qty}  → owed $${(over / 100).toFixed(2)}  [${r.financial_status}]`);
    }
    console.log(`\nTOTAL OWED: $${(owed / 100).toFixed(2)}`);
  } finally { await c.end(); }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
