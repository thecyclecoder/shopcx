import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const M = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();
  const ctx = await M.loadPricingContext(WS, RULE);
  const snaps: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("appstle_contract_snapshots").select("appstle_contract_id,status,raw,lines,delivery_price_cents").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; snaps.push(...data); if(data.length<1000)break; }
  const typeCount: Record<string, number> = {};
  let withCodes=0, carryable=0, pctSkipped=0, limitPartial=0, contractsCarry=new Set<string>();
  const ex: string[] = [];
  const pctEx: string[] = [];
  let noDeliveryMethod=0, noAddr=0, noPM=0;
  for (const s of snaps) {
    const raw = s.raw as any;
    if (!raw) continue;
    const nodes = raw?.discounts?.nodes ?? [];
    if (nodes.length) withCodes++;
    for (const d of nodes) {
      typeCount[String(d.type)] = (typeCount[String(d.type)]||0)+1;
      if (String(d.type) !== "CODE_DISCOUNT") continue;
      const amt = d?.value?.amount?.amount;
      const limit = d.recurringCycleLimit ?? null;
      const used = Number(d.usageCount ?? 0);
      if (amt == null || !Number.isFinite(parseFloat(String(amt)))) { pctSkipped++; if (pctEx.length<5) pctEx.push(`${s.appstle_contract_id} ${JSON.stringify(d).slice(0,300)}`); continue; }
      if (limit != null && used >= limit) continue;
      carryable++; contractsCarry.add(s.appstle_contract_id);
      if (limit != null && used > 0 && used < limit) limitPartial++;
      if (ex.length<6) ex.push(`${s.appstle_contract_id} ${JSON.stringify({title:d.title, type:d.type, value:d.value, limit, used})}`);
    }
    if (!raw.deliveryMethod) noDeliveryMethod++;
    const a = raw?.deliveryMethod?.address;
    if (!a || !Object.keys(a).length) noAddr++;
    if (!raw?.customerPaymentMethod?.id) noPM++;
  }
  console.log({ typeCount, withCodes, carryable, contractsCarry: contractsCarry.size, pctSkipped, limitPartial, noDeliveryMethod, noAddr, noPM });
  console.log("carryable examples:\n", ex.join("\n "));
  console.log("skipped(non-fixed) examples:\n", pctEx.join("\n "));
  // sample raw keys of one contract
  const one = snaps.find(s=>s.raw);
  console.log("raw top-level keys:", Object.keys(one.raw).join(", "));
  console.log("sample discounts node:", JSON.stringify(one.raw.discounts).slice(0,600));
  console.log("sample deliveryMethod:", JSON.stringify(one.raw.deliveryMethod).slice(0,600));
  console.log("sample billingAddress:", JSON.stringify(one.raw?.customerPaymentMethod?.instrument?.billingAddress).slice(0,600));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
