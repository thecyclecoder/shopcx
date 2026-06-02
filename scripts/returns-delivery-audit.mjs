import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// All returns with an EasyPost label, ordered by created date desc
const { data: returns } = await admin
  .from("returns")
  .select("id, order_number, status, customer_id, tracking_number, carrier, label_url, label_cost_cents, easypost_shipment_id, shipped_at, delivered_at, refunded_at, refund_id, resolution_type, source, created_at")
  .eq("workspace_id", W)
  .not("easypost_shipment_id", "is", null)
  .order("created_at", { ascending: false });

console.log(`${returns?.length || 0} returns with EasyPost labels:\n`);

const buckets = { label_created: 0, in_transit: 0, delivered: 0, refunded: 0, other: 0 };
for (const r of returns || []) {
  const { data: cust } = r.customer_id
    ? await admin.from("customers").select("first_name, last_name, email").eq("id", r.customer_id).maybeSingle()
    : { data: null };
  const name = cust ? `${cust.first_name || ""} ${cust.last_name || ""}`.trim() : "—";
  const ageDays = ((Date.now() - new Date(r.created_at).getTime()) / 86400000).toFixed(1);

  console.log(`────────────────────────────────────────`);
  console.log(`${r.order_number}  ${name} <${cust?.email || "?"}>`);
  console.log(`  status=${r.status}  resolution=${r.resolution_type}  source=${r.source}  age=${ageDays}d`);
  console.log(`  ${r.carrier} #${r.tracking_number || "—"}`);
  console.log(`  shipped_at:   ${r.shipped_at?.slice(0,16) || "—"}`);
  console.log(`  delivered_at: ${r.delivered_at?.slice(0,16) || "—"}`);
  console.log(`  refunded_at:  ${r.refunded_at?.slice(0,16) || "—"}  refund_id=${r.refund_id || "—"}`);
  console.log(`  label cost: $${((r.label_cost_cents || 0)/100).toFixed(2)}`);

  const k = ["label_created", "in_transit", "delivered", "refunded"].includes(r.status) ? r.status : "other";
  buckets[k]++;
}

console.log(`\n──────── Status summary ────────`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(15)} ${v}`);
