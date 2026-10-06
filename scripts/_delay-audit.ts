/** Every active ShopCX sub: is its next charge later than one cadence after its last charge? */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const cad=(i:string|null,n:number|null)=>{const x=String(i??"month").toLowerCase();const k=n??1;return x==="week"?7*k:x==="day"?k:x==="year"?365*k:30*k;};
async function main(){
  const admin=createAdminClient();
  const subs:any[]=[];
  for(let f=0;;f+=1000){
    const {data}=await admin.from("subscriptions")
      .select("id,shopify_contract_id,next_billing_date,billing_interval,billing_interval_count,status,migrated_from_contract_id,customer_id")
      .eq("workspace_id",WS).eq("billing_source","shopcx").eq("status","active").range(f,f+999);
    if(!data?.length)break; subs.push(...data); if(data.length<1000)break;
  }
  console.log(`active shopcx subs: ${subs.length}`);
  const buckets:Record<string,number>={}; const late:any[]=[]; let noHistory=0;
  for(const s of subs){
    const {data:last}=await admin.from("orders").select("created_at")
      .eq("workspace_id",WS).eq("subscription_id",s.id).order("created_at",{ascending:false}).limit(1);
    if(!last?.[0]){ noHistory++; continue; }
    const c=cad(s.billing_interval,s.billing_interval_count);
    const gap=Math.round((new Date(s.next_billing_date!).getTime()-new Date(last[0].created_at as string).getTime())/86400000);
    const extra=gap-c;
    const k = extra<=1 ? "on cadence (≤ +1d)" : extra<=7 ? "+2-7d" : extra<=c*0.5 ? `+8d..half a cycle` : extra<=c ? "up to one extra cycle" : "more than one extra cycle";
    buckets[k]=(buckets[k]??0)+1;
    if(extra>c*0.5) late.push({id:s.shopify_contract_id,gap,c,extra,next:s.next_billing_date,cust:s.customer_id,last:last[0].created_at});
  }
  console.log(`no order history yet (never renewed under us): ${noHistory}`);
  console.log(`\ndelay vs their own cadence:`);
  for(const [k,v] of Object.entries(buckets).sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`\nmaterially delayed (> half a cycle late): ${late.length}`);
  for(const l of late.sort((a,b)=>b.extra-a.extra)){
    const {data:c}=await admin.from("customers").select("email").eq("id",l.cust).maybeSingle();
    console.log(`  ${l.id}  ${c?.email}  cadence ${l.c}d  last ${String(l.last).slice(0,10)}  next ${String(l.next).slice(0,10)}  = +${l.extra}d`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
