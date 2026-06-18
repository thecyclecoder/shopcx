import { readFileSync, existsSync, writeFileSync } from "node:fs"; import { resolve } from "node:path"; import { randomUUID } from "node:crypto";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SUB="dff29e0d"; // the 2-unit sub (contract 27967193261)
const COFFEE_UUID="c1e1e38d-80d9-4bc7-aee2-7f44a2f30fcd";
const COFFEE_PRODUCT="";
(async()=>{
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: v } = await admin.from("product_variants").select("id,product_id,title,sku,products(title)").eq("id",COFFEE_UUID).single();
  const { data: subs } = await admin.from("subscriptions").select("id,shopify_contract_id,customer_id").eq("workspace_id",WS).eq("shopify_contract_id","27967193261").single().then(r=>({data:[r.data]})).catch(()=>({data:[]}));
  const sub = subs[0]; if(!sub){console.log("sub not found");return;}
  // 2 units, base override 5327 → 25% off = 3995 = $39.95 each
  const items = [{
    variant_id: COFFEE_UUID, product_id: v!.product_id,
    title: (v!.products as any)?.title || "Amazing Coffee K-Cups", variant_title: v!.title || "Cocoa",
    sku: v!.sku || undefined, quantity: 2, price_override_cents: 5327, line_id: randomUUID(),
  }];
  const next = new Date(); next.setUTCDate(next.getUTCDate()+8*7); next.setUTCHours(8,0,0,0); // bi-monthly
  const internalId = `internal-${randomUUID().replace(/-/g,"").slice(0,16)}`;
  await admin.from("subscriptions").update({
    is_internal: true, status: "active", shopify_contract_id: internalId,
    items, next_billing_date: next.toISOString(), billing_interval: "week", billing_interval_count: 8,
    updated_at: new Date().toISOString(),
  }).eq("id", sub.id);
  console.log(`Mary's 2-unit sub ${sub.id.slice(0,8)} → INTERNAL active, contract ${internalId}, next ${next.toISOString().slice(0,10)}`);
  // verify engine pricing
  const { resolveSubscriptionPricing } = await import("../src/lib/pricing");
  const { data: s2 } = await admin.from("subscriptions").select("*").eq("id",sub.id).single();
  const p = await resolveSubscriptionPricing(WS, s2);
  console.log("ENGINE:", JSON.stringify({subtotal:p.product_subtotal_cents, free_ship:p.free_shipping}));
  for (const l of p.lines) console.log(`  ${l.title} ${l.variant_title} q${l.quantity}: base $${(l.base_cents/100).toFixed(2)} → $${(l.unit_cents/100).toFixed(2)} (sns ${l.sns_pct}% brk ${l.break_pct}%)`);
}
)().catch(e=>console.error("ERR:",e.message));
