import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const isUuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
(async()=>{
  const a=createAdminClient();
  const { data } = await a.from("fraud_cases").select("id,order_ids,status").eq("workspace_id",WS).not("order_ids","is",null).limit(200);
  let uuidCount=0, nonUuidCount=0; const badSamples:string[]=[];
  for(const c of (data||[]) as any[]){
    for(const oid of (c.order_ids||[])){
      if(isUuid(String(oid))) uuidCount++;
      else { nonUuidCount++; if(badSamples.length<6) badSamples.push(String(oid)); }
    }
  }
  console.log(`fraud_cases scanned: ${data?.length} · order_ids that are UUID: ${uuidCount} · NON-uuid (shopify ids): ${nonUuidCount}`);
  console.log("non-uuid samples:", badSamples.join(", ")||"(none)");
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
