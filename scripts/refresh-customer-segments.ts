/**
 * Recompute customers.segments — the manual escape hatch. Now a thin wrapper over the
 * set-based public.refresh_customer_segments(workspace_id, all) SQL function (migration
 * 20260704160000): the whole book recomputes in ONE statement inside Postgres (~1 min for
 * 138K), replacing the old ~3-hour per-customer read/compute/write loop.
 *
 * Segment predicates live in the SQL function (mirror computeSegments): cold · single_order ·
 * just_ordered · cycle_hitter · lapsed · deep_lapsed · engaged · active_sub · storefront_signup.
 *
 * Usage:
 *   npx tsx scripts/refresh-customer-segments.ts          # SMS-subscribed only (default)
 *   npx tsx scripts/refresh-customer-segments.ts --all    # everyone in the workspace
 */
import { pgClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ALL = process.argv.includes("--all");

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    console.log(`Refreshing segments (scope: ${ALL ? "all" : "SMS-subscribed"}) via set-based SQL...`);
    const t0 = Date.now();
    const { rows } = await c.query("select public.refresh_customer_segments($1, $2) as n", [WS, ALL]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✓ DONE — updated ${rows[0].n} customers in ${secs}s\n`);

    // Segment distribution (customers can be in multiple).
    const scope = ALL ? "" : "and sms_marketing_status='subscribed'";
    const { rows: dist } = await c.query(
      `select seg, count(*) n from customers c, unnest(c.segments) seg
       where c.workspace_id=$1 ${scope} group by seg order by n desc`, [WS]);
    console.log("Segment counts:");
    for (const r of dist) console.log(`  ${String(r.seg).padEnd(18)} ${r.n}`);
  } finally {
    await c.end();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e); process.exit(1); });
