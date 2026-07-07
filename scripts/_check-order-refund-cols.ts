import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  // a real order — all columns
  const { data: o } = await db.from("orders").select("*").eq("workspace_id",WS).limit(1).maybeSingle();
  console.log("=== ORDERS columns ===");
  console.log(Object.keys(o||{}).join(", "));
  console.log("\n=== refund-ish order columns ===");
  for (const k of Object.keys(o||{})) if(/refund|financial|refunded|total_refund/i.test(k)) console.log("  "+k+":", JSON.stringify((o as any)[k]).slice(0,120));

  // returns table columns
  const { data: r } = await db.from("returns").select("*").eq("workspace_id",WS).limit(1).maybeSingle();
  console.log("\n=== RETURNS columns ===");
  console.log(Object.keys(r||{}).join(", "));
  console.log("refund-ish:", Object.keys(r||{}).filter(k=>/refund/i.test(k)).join(", "));

  // Do any orders actually carry a nonzero refund amount / refunded status?
  for (const col of ["total_refunded_cents","refunded_amount_cents","refund_amount_cents","amount_refunded"]) {
    const { count, error } = await db.from("orders").select("*",{count:"exact",head:true}).eq("workspace_id",WS).gt(col,0);
    if (!error) console.log(`orders with ${col}>0:`, count);
  }
  const { count: fr, error: fe } = await db.from("orders").select("*",{count:"exact",head:true}).eq("workspace_id",WS).in("financial_status",["refunded","partially_refunded"]);
  if (!fe) console.log("orders financial_status in (refunded, partially_refunded):", fr);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
