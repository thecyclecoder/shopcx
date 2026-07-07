import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const CUST = "7f215e32-a825-4a55-b558-9630dd2357c9";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const j = (o:any)=>JSON.stringify(o);
(async () => {
  const db = createAdminClient();
  const { data: c } = await db.from("customers").select("*").eq("id",CUST).single();
  console.log("=== CUSTOMER ===");
  console.log("name:", (c as any)?.first_name, (c as any)?.last_name, "| email:", (c as any)?.email);
  for (const k of Object.keys(c||{})) { const v=(c as any)[k]; if(/addr|city|state|zip|province|postal|ship/i.test(k) && v) console.log("  ."+k+":", typeof v==="object"?j(v):v); }

  console.log("\n=== ADDRESSES table ===");
  const { data: addrs, error: ae } = await db.from("customer_addresses").select("*").eq("customer_id",CUST);
  if (ae) console.log("(no customer_addresses table:", ae.message, ")");
  for (const a of addrs||[]) console.log("  ["+((a as any).is_default?"DEFAULT":"")+"]", j({id:(a as any).id, l1:(a as any).address1, city:(a as any).city, state:(a as any).province??(a as any).state, zip:(a as any).zip??(a as any).postal_code, updated:(a as any).updated_at}));

  console.log("\n=== ORDERS ===");
  const { data: orders } = await db.from("orders").select("*").eq("customer_id",CUST).order("created_at",{ascending:false}).limit(12);
  for (const o of orders||[]) {
    console.log(`  ${(o as any).order_number ?? (o as any).name} [${(o as any).status ?? (o as any).financial_status}] ${(o as any).created_at?.slice(0,16)} id=${(o as any).id?.slice(0,8)}`);
    const ship = (o as any).shipping_address ?? (o as any).ship_to ?? null;
    if (ship) console.log("       ship:", typeof ship==="object"? j({l1:ship.address1, city:ship.city, state:ship.province??ship.state, zip:ship.zip??ship.postal_code}) : ship);
    for (const k of Object.keys(o||{})) { if(/ship.*addr|address1|_city|_state|_zip/i.test(k)){ const v=(o as any)[k]; if(v) console.log("       ."+k+":", typeof v==="object"?j(v):v);} }
  }

  console.log("\n=== SUBSCRIPTIONS ===");
  const { data: subs } = await db.from("subscriptions").select("*").eq("customer_id",CUST);
  for (const s of subs||[]) {
    console.log(`  sub ${(s as any).id?.slice(0,8)} [${(s as any).status}] internal=${(s as any).is_internal} contract=${(s as any).shopify_contract_id ?? "-"}`);
    const sa=(s as any).shipping_address ?? (s as any).delivery_address ?? null;
    if (sa) console.log("       ship:", typeof sa==="object"? j({l1:sa.address1,city:sa.city,state:sa.province??sa.state,zip:sa.zip??sa.postal_code}) : sa);
  }
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
