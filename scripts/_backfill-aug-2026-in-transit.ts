/**
 * ONE-TIME reconstruction of the 2026-08-31 in-transit position.
 *
 * The close's third bucket ([[qb_inbound_shipment_snapshots]]) starts collecting from the day the
 * daily sync ships. August 2026 predates it, and the position CANNOT be re-fetched: Amazon's
 * shipments FBA19L2QSDBF / FBA19LT0NTKJ now read fully received, so `shipped − received` is 0.
 *
 * BASIS (arrival record, not a guess): every unit Amazon newly recognised on 2026-09-01 had
 * already left Amplifier — the 3PL case SKUs decremented on 08-15 and both shipments were created
 * 08-07 / 08-14. So it was in transit on the 08-31 cutoff.
 *
 *   in_transit(08-31, asin) = max(0, (fulfillable+transit)@09-01 − (fulfillable+transit)@08-31)
 *
 * Using the delta of Amazon's TOTAL known position (fulfillable + transit) is what makes this safe
 * from double-counting: anything Amazon already knew about on 08-31 is inside the 08-31 term and
 * cancels. Sales on 09-01 make it a slight UNDER-estimate — conservative, the right direction for
 * an inventory adjustment.
 *
 * Idempotent: upserts on (workspace_id, snapshot_date, shipment_id, seller_sku).
 * Dry-run by default; pass --apply to write.
 *
 * Run: npx tsx scripts/_backfill-aug-2026-in-transit.ts [--apply]
 */
import { pgClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SNAPSHOT = "2026-08-31";
const CHECKIN = "2026-09-01";
const SHIPMENT_ID = "RECONSTRUCTED-2026-09-01-CHECKIN";
const APPLY = process.argv.includes("--apply");

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows } = await c.query(
      `with a as (select asin, quantity_fulfillable + quantity_transit t
                  from qb_amazon_inventory_snapshots where workspace_id=$1 and snapshot_date=$2),
            b as (select asin, quantity_fulfillable + quantity_transit t
                  from qb_amazon_inventory_snapshots where workspace_id=$1 and snapshot_date=$3)
       select b.asin, a.t before, b.t after, b.t - a.t delta
       from b join a on a.asin = b.asin
       where b.t - a.t > 0 order by delta desc`,
      [WS, SNAPSHOT, CHECKIN],
    );
    const total = rows.reduce((n, r) => n + Number(r.delta), 0);
    console.log(`${rows.length} ASIN(s) newly recognised on ${CHECKIN} — ${total} unit(s) in transit at ${SNAPSHOT}\n`);
    console.log("  asin           08-31   09-01   in_transit");
    for (const r of rows)
      console.log(`  ${r.asin.padEnd(13)} ${String(r.before).padStart(6)} ${String(r.after).padStart(7)} ${String(r.delta).padStart(12)}`);

    if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); return; }

    for (const r of rows) {
      await c.query(
        `insert into qb_inbound_shipment_snapshots
           (workspace_id, snapshot_date, shipment_id, shipment_name, shipment_status,
            seller_sku, asin, quantity_shipped, quantity_received, in_transit)
         values ($1,$2,$3,$4,'RECONSTRUCTED',$5,$5,$6,0,$6)
         on conflict (workspace_id, snapshot_date, shipment_id, seller_sku)
         do update set quantity_shipped = excluded.quantity_shipped, in_transit = excluded.in_transit`,
        [WS, SNAPSHOT, SHIPMENT_ID, `reconstructed from the ${CHECKIN} Amazon check-in`, r.asin, Number(r.delta)],
      );
    }
    const { rows: chk } = await c.query(
      `select count(*)::int n, coalesce(sum(in_transit),0)::int units
         from qb_inbound_shipment_snapshots where workspace_id=$1 and snapshot_date=$2`, [WS, SNAPSHOT]);
    console.log(`\n✓ wrote ${chk[0].n} row(s), ${chk[0].units} unit(s) in transit at ${SNAPSHOT}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
