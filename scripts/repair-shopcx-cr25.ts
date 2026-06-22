import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CONTRACT="internal-0a70a2873a683d17"; // 9cc6a205 (Coffee + Creamer)
(async()=>{
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { resolveCoupon, applyCouponToSub } = await import("../src/lib/coupons");
  const { priceSubscription } = await import("../src/lib/portal/helpers/enrich-pricing");
  const admin = createAdminClient();

  const resolved = await resolveCoupon(WS, "SHOPCX-CR25", null);
  console.log("resolved SHOPCX-CR25:", JSON.stringify(resolved));
  if (!resolved) { console.log("NOT FOUND on internal table or Shopify — cannot repair."); return; }

  const r = await applyCouponToSub(WS, CONTRACT, "SHOPCX-CR25", null);
  console.log("applyCouponToSub:", JSON.stringify(r));

  const { data: sub } = await admin.from("subscriptions").select("*").eq("shopify_contract_id",CONTRACT).single();
  console.log("applied_discounts now:", JSON.stringify(sub?.applied_discounts));
  const { pricing } = await priceSubscription(WS, sub);
  console.log(`per-delivery now: $${(pricing.total_cents/100).toFixed(2)} (subtotal $${(pricing.subtotal_cents/100).toFixed(2)} − coupon $${(pricing.discount_cents/100).toFixed(2)} + protection $${(pricing.protection_cents/100).toFixed(2)})`);
  console.log("pills:", pricing.pills.map(p=>p.label).join(" | "));
}
)().catch(e=>console.error("ERR:",e.message));
