import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: r } = await db.from("replacements").select("*").eq("shopify_order_name","SC134266").maybeSingle();
  console.log("replacement row addr:", JSON.stringify((r as any)?.validated_address));
  const { data: o } = await db.from("orders").select("order_number,shipping_address").eq("order_number","SC134266").maybeSingle();
  if (o) console.log("order SC134266 ship:", JSON.stringify((o as any).shipping_address));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
