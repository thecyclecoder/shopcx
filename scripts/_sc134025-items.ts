import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: o } = await db.from("orders").select("*").eq("order_number","SC134025").single();
  console.log("order id:", (o as any).id, "total:", (o as any).total_price ?? (o as any).total, "created:", (o as any).created_at);
  const li = (o as any).line_items ?? (o as any).items ?? null;
  console.log("line_items(inline):", li? JSON.stringify(li).slice(0,600):"(none inline)");
  // separate table?
  const { data: items } = await db.from("order_line_items").select("*").eq("order_id",(o as any).id).maybeSingle ? await db.from("order_line_items").select("*").eq("order_id",(o as any).id) : {data:null} as any;
  if (items && items.length) for (const it of items) console.log("  item:", JSON.stringify({title:(it as any).title, variant:(it as any).variant_id??(it as any).shopify_variant_id, qty:(it as any).quantity}));
  // subscription line items
  const { data: subs } = await db.from("subscriptions").select("id,line_items,shopify_contract_id").eq("customer_id","7f215e32-a825-4a55-b558-9630dd2357c9");
  for (const s of subs||[]) console.log("sub", (s as any).id.slice(0,8), "items:", JSON.stringify((s as any).line_items).slice(0,400));
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
