import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const M = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();
  const ctx = await M.loadPricingContext(WS, RULE);
  console.log("variantBySku('insure01') ->", JSON.stringify(ctx.variantBySku.get("insure01")));
  const snaps: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("appstle_contract_snapshots").select("*").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; snaps.push(...data); if(data.length<1000)break; }
  const subs = new Map<string, any>();
  for (let from=0;;from+=1000){ const {data} = await admin.from("subscriptions").select("id, shopify_contract_id, status, next_billing_date").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; data.forEach((s:any)=>subs.set(String(s.shopify_contract_id), s)); if(data.length<1000)break; }
  console.log("subs rows:", subs.size);
  let matched=0, activeMatched=0;
  const droppedReasons: Record<string,number> = {};
  let protLines=0, protRemap=0, protQty2=0;
  const protVids: Record<string,number> = {};
  let deliv=0, delivActive=0;
  const now = Date.now();
  let nbdPast=0, nbdFar=0, nbdDiverge=0, nbdNull=0;
  const divEx: string[] = [];
  let dueToday=0;
  for (const s of snaps) {
    const sub = subs.get(String(s.appstle_contract_id));
    if (sub) matched++;
    const isActive = sub?.status === "active";
    if (isActive) activeMatched++;
    if ((s.delivery_price_cents??0)>0) { deliv++; if (isActive) delivActive++; }
    const plan = M.planMigration(s as any, ctx);
    plan.dropped.forEach(d=>droppedReasons[d.reason]=(droppedReasons[d.reason]||0)+1);
    for (const l of plan.lines) if (l.isProtection) { protLines++; protVids[l.shopifyVariantId]=(protVids[l.shopifyVariantId]||0)+1; if (l.remappedFrom) protRemap++; }
    for (const l of (s.lines??[])) { const t=String(l.title??""); if (/protection/i.test(t) && Number(l.quantity)>1) protQty2++; }
    if (s.status !== "ACTIVE" || !isActive) continue;
    const ours = sub?.next_billing_date ? new Date(sub.next_billing_date).getTime() : NaN;
    const theirs = s.next_billing_date ? new Date(s.next_billing_date).getTime() : NaN;
    if (!Number.isFinite(ours)) { nbdNull++; continue; }
    if (ours < now - 86400000) nbdPast++;
    const t2 = s.next_billing_date ? new Date(s.next_billing_date).getTime() : NaN;
    if (Number.isFinite(t2)) {
      const dd = (t2 - now)/86400000;
      if (dd > -1 && dd < 1) dueToday++;
      const diff = Math.abs(ours - theirs)/86400000;
      if (diff > 2) { nbdDiverge++; if (divEx.length<8) divEx.push(`${s.appstle_contract_id} ours=${sub.next_billing_date} appstle=${s.next_billing_date} diff=${diff.toFixed(1)}d`); }
      if (ours - now > 120*86400000) nbdFar++;
    }
  }
  console.log({ matched, activeMatched, deliv, delivActive, droppedReasons, protLines, protRemap, protQty2, protVids });
  console.log({ nbdNull, nbdPast, nbdFar, nbdDiverge, dueToday });
  console.log(divEx);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
