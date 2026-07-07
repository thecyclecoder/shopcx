import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const { data: evs } = await db.from("customer_events")
    .select("id, customer_id, created_at, summary, properties")
    .eq("workspace_id", WS).eq("event_type","order.refunded").order("created_at",{ascending:true});
  const total=(evs||[]).length;
  // bucket by method + try to extract any order ref
  const methodCount:Record<string,number>={};
  const refByKey:Record<string, {at:string,amount:number,method:string,rid:any,key:string,internal?:boolean}[]>={};
  let noRef=0;
  for (const e of evs||[]) {
    const p=(e as any).properties||{};
    const m=p.method||"?"; methodCount[m]=(methodCount[m]||0)+1;
    const key = p.order_id || p.order_number || null;
    if (!key) { noRef++; continue; }
    (refByKey[String(key)] ||= []).push({at:(e as any).created_at,amount:p.amount_cents,method:m,rid:p.refund_id,key:String(key)});
  }
  console.log("total refund events:", total, "| by method:", JSON.stringify(methodCount), "| events w/ no order ref:", noRef);
  const keys=Object.keys(refByKey);
  // resolve orders by id OR order_number
  const ids=keys.filter(k=>/^[0-9a-f-]{36}$/.test(k));
  const nums=keys.filter(k=>!/^[0-9a-f-]{36}$/.test(k));
  const meta:Record<string,any>={};
  if (ids.length){ const {data:o}=await db.from("orders").select("id,order_number,shopify_order_id").in("id",ids); for(const x of o||[]) { meta[(x as any).id]=x; meta[(x as any).order_number]=x; } }
  if (nums.length){ const {data:o}=await db.from("orders").select("id,order_number,shopify_order_id").in("order_number",nums); for(const x of o||[]) { meta[(x as any).id]=x; meta[(x as any).order_number]=x; } }
  let internal=0, shopify=0, unknown=0; const multi:string[]=[];
  for (const k of keys){ const o=meta[k]; const isInt = o? !o.shopify_order_id : null;
    if (isInt===true) internal++; else if (isInt===false) shopify++; else unknown++;
    const refs=refByKey[k]; const distinctRid=new Set(refs.map(r=>String(r.rid)));
    if (refs.length>1) multi.push(`${isInt===true?"INTERNAL":isInt===false?"shopify":"unknown"} ${o?.order_number??k.slice(0,10)} — ${refs.length} events / ${distinctRid.size} distinct refund_id: `+refs.map(r=>`$${(r.amount/100).toFixed(2)}@${r.at.slice(5,16)}`).join(" | "));
  }
  console.log(`attributed orders: ${keys.length} | INTERNAL=${internal} shopify=${shopify} unknown=${unknown}`);
  console.log(`orders with >1 refund event: ${multi.length}`);
  for (const d of multi) console.log("  "+d);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
