import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "/Users/admin/Projects/shopcx/scripts/env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: order } = await admin.from("orders")
  .select("id, shopify_order_id, order_number, total_cents, customer_id, workspace_id, shipping_address, billing_address, line_items, financial_status, fulfillment_status")
  .eq("order_number", "SC129803")
  .single();
console.log(JSON.stringify(order, null, 2));
