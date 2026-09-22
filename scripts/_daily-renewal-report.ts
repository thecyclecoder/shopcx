/** What the shopcx renewal cron did on a given day. */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DAY = process.argv[2] ?? new Date().toISOString().slice(0,10);
const money = (c:number)=>`$${(c/100).toFixed(2)}`;
async function main() {
  const admin = createAdminClient();
  const from = `${DAY}T00:00:00Z`, to = `${DAY}T23:59:59Z`;

  // every shopcx sub that was due on or before this day
  const { data: shopcx } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, next_billing_date, last_payment_status, items, migrated_from_contract_id")
    .eq("workspace_id",WS).eq("billing_source","shopcx").neq("status","cancelled");
  const ids = (shopcx ?? []).map(s=>s.id);

  const { data: orders } = await admin.from("orders")
    .select("order_number, subscription_id, total_cents, created_at, financial_status")
    .eq("workspace_id",WS).in("subscription_id", ids).gte("created_at",from).lte("created_at",to).order("created_at");
  let rev=0; for (const o of orders ?? []) rev += o.total_cents ?? 0;
  console.log(`=== ${DAY} — shopcx renewals ===`);
  console.log(`orders: ${orders?.length}   collected: ${money(rev)}`);

  const { data: pf } = await admin.from("payment_failures")
    .select("shopify_contract_id, error_code, error_message, created_at, attempt_type")
    .eq("workspace_id",WS).gte("created_at",from).lte("created_at",to).order("created_at");
  const shopcxIds = new Set((shopcx ?? []).map(s=>s.shopify_contract_id));
  const mine = (pf ?? []).filter(f=>shopcxIds.has(f.shopify_contract_id as string));
  console.log(`\nshopcx payment failures today: ${mine.length}  (all engines: ${pf?.length})`);
  for (const f of mine) console.log(`  ${f.shopify_contract_id}  ${f.error_code}  ${String(f.error_message).slice(0,55)}  [${f.attempt_type ?? "renewal"}]`);

  const { data: dun } = await admin.from("dunning_cycles")
    .select("shopify_contract_id, status, created_at, subscription_id")
    .eq("workspace_id",WS).gte("created_at",from).lte("created_at",to);
  const myDun = (dun ?? []).filter(d=>ids.includes(d.subscription_id as string));
  console.log(`\ndunning cycles opened today: ${myDun.length} shopcx (${dun?.length} all engines)`);
  for (const d of myDun) console.log(`  ${d.shopify_contract_id}  ${d.status}`);

  // anything that SHOULD have charged today and has no order
  const dueToday = (shopcx ?? []).filter(s => s.status==="active" && s.next_billing_date && s.next_billing_date <= to);
  const charged = new Set((orders ?? []).map(o=>o.subscription_id));
  // ⚠️ Check ALL open dunning cycles, not just ones opened today. A sub declining on Monday sits
  // in a cycle whose next retry is Friday — it is neither charged nor newly dunned in between, and
  // filtering on today's cycles alone reports it as a MISSED RENEWAL every day until it resolves.
  const { data: openDun } = await admin.from("dunning_cycles")
    .select("subscription_id").eq("workspace_id",WS)
    .in("status",["active","rotating","retrying","skipped","paused"]);
  const inDunning = new Set((openDun ?? []).map(d=>d.subscription_id));
  const missed = dueToday.filter(s => !charged.has(s.id) && !inDunning.has(s.id));
  console.log(`\ndue on/before today: ${dueToday.length}   charged: ${orders?.length}   neither charged nor dunned: ${missed.length}`);
  for (const m of missed.slice(0,12)) console.log(`  ⚠️ ${m.shopify_contract_id} due ${String(m.next_billing_date).slice(0,10)} pay=${m.last_payment_status}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
