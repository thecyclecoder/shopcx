import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  // All refund events
  const { data: evs } = await db.from("customer_events")
    .select("id, customer_id, created_at, summary, properties")
    .eq("workspace_id", WS).eq("event_type","order.refunded")
    .order("created_at",{ascending:true});
  console.log("total order.refunded events:", (evs||[]).length);

  // group by order_id
  type Ref = { at:string, amount:number, method:string, refund_id:any, cust:string };
  const byOrder: Record<string, Ref[]> = {};
  for (const e of evs||[]) {
    const p = (e as any).properties || {};
    const oid = p.order_id; if (!oid) continue;
    (byOrder[oid] ||= []).push({ at:(e as any).created_at, amount:p.amount_cents, method:p.method, refund_id:p.refund_id, cust:(e as any).customer_id });
  }
  const orderIds = Object.keys(byOrder);
  console.log("distinct orders refunded:", orderIds.length);

  // classify internal vs shopify
  const { data: orders } = await db.from("orders").select("id, order_number, shopify_order_id, braintree_transaction_id").in("id", orderIds);
  const ometa: Record<string, any> = {}; for (const o of orders||[]) ometa[(o as any).id]=o;
  let internalCount=0, shopifyCount=0;
  const dupes: string[] = [];
  for (const oid of orderIds) {
    const o = ometa[oid]; const internal = o && !o.shopify_order_id;
    if (internal) internalCount++; else shopifyCount++;
    const refs = byOrder[oid];
    // genuine double = >1 DISTINCT refund_id (or >1 event with null/diff ids)
    const distinctRefIds = new Set(refs.map(r=>String(r.refund_id)));
    if (refs.length > 1) {
      dupes.push(`${internal?"INTERNAL":"shopify "} ${o?.order_number??oid.slice(0,8)} — ${refs.length} refund events, ${distinctRefIds.size} distinct refund_id(s): ` +
        refs.map(r=>`$${(r.amount/100).toFixed(2)}/${String(r.refund_id).slice(0,10)}@${r.at.slice(5,16)}`).join("  |  "));
    }
  }
  console.log(`internal-order refunds: ${internalCount} | shopify-order refunds: ${shopifyCount}`);
  console.log(`\norders with >1 refund event (${dupes.length}):`);
  for (const d of dupes) console.log("  " + d);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
