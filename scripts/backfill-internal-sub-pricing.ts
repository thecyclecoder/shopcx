import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path"; import { randomUUID } from "node:crypto";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
(async()=>{
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();

  async function resolveVar(idOrShopify: string){
    const col = UUID_RE.test(idOrShopify) ? "id" : "shopify_variant_id";
    const { data } = await admin.from("product_variants").select("id,product_id,title,sku,products(title)").eq(col,idOrShopify).maybeSingle();
    return data as any;
  }

  const { data: subs } = await admin.from("subscriptions").select("id,shopify_contract_id,items").eq("workspace_id",WS).eq("is_internal",true);
  for (const s of subs||[]) {
    let items = (s.items as any[])||[];
    // Restore empty faccb27b with Ashwavana (UUID ref, no baked price).
    if (items.length === 0 && s.id === "faccb27b-eec2-4671-b2ad-8bcd574c9ea0") {
      const v = await resolveVar("01eab80d-bf3d-4dea-9df4-1402518a32d0");
      items = [{ variant_id: v.id, product_id: v.product_id, title: (v.products?.title)||"Ashwavana Guru Focus", variant_title: v.title, sku: v.sku||undefined, quantity: 1, line_id: randomUUID() }];
      console.log(`  ${s.id.slice(0,8)}: restored Ashwavana line`);
    }
    const next: any[] = [];
    for (const i of items) {
      const isProt = String(i.title||"").toLowerCase().includes("shipping protection");
      if (isProt) { next.push(i); continue; } // passthrough — keep price_cents
      const v = await resolveVar(String(i.variant_id));
      if (!v) { console.log(`  ${s.id.slice(0,8)}: variant ${i.variant_id} NOT in catalog — left as-is`); next.push(i); continue; }
      const { price_cents, ...rest } = i; // drop baked price
      next.push({ ...rest, variant_id: v.id, product_id: v.product_id, variant_title: i.variant_title ?? v.title, sku: i.sku ?? v.sku ?? undefined, line_id: i.line_id || randomUUID() });
    }
    await admin.from("subscriptions").update({ items: next, updated_at: new Date().toISOString() }).eq("id", s.id);
    console.log(`  ${s.id.slice(0,8)} (${s.shopify_contract_id}): ${next.length} items normalized → ${next.map(x=>x.variant_id.slice(0,8)).join(", ")}`);
  }
  console.log("\n=== verify with engine ===");
  const { resolveSubscriptionPricing } = await import("../src/lib/pricing");
  const { data: subs2 } = await admin.from("subscriptions").select("*").eq("workspace_id",WS).eq("is_internal",true);
  for (const s of subs2||[]) {
    const p = await resolveSubscriptionPricing(WS, s);
    console.log(`${s.id.slice(0,8)}: subtotal $${(p.product_subtotal_cents/100).toFixed(2)} free_ship=${p.free_shipping}`);
    for (const l of p.lines) console.log(`   ${l.title} ${l.variant_title} q${l.quantity}: $${(l.base_cents/100).toFixed(2)} → $${(l.unit_cents/100).toFixed(2)} (brk${l.break_pct}% sns${l.sns_pct}%)`);
  }
}
)().catch(e=>console.error("ERR:",e.message));
