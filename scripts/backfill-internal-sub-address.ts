import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: subs } = await admin.from("subscriptions").select("id,customer_id,shipping_address").eq("workspace_id",WS).eq("is_internal",true).is("shipping_address",null);
  console.log(`internal subs missing shipping_address: ${subs?.length||0}`);
  for (const s of subs||[]) {
    const { data: lo } = await admin.from("orders").select("shipping_address").eq("subscription_id",s.id).not("shipping_address","is",null).order("created_at",{ascending:false}).limit(1).maybeSingle();
    let addr = lo?.shipping_address;
    if (!addr) { const { data: lo2 } = await admin.from("orders").select("shipping_address").eq("customer_id",s.customer_id).not("shipping_address","is",null).order("created_at",{ascending:false}).limit(1).maybeSingle(); addr = lo2?.shipping_address; }
    if (addr) { await admin.from("subscriptions").update({ shipping_address: addr, updated_at:new Date().toISOString() }).eq("id",s.id); console.log(`  ${s.id.slice(0,8)}: backfilled from order`); }
    else console.log(`  ${s.id.slice(0,8)}: no order address found — left null`);
  }
}
)().catch(e=>console.error(e.message));
