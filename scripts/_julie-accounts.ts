import { createAdminClient } from "./_bootstrap";

const IDS = [
  "1b11a298-0182-4246-95b7-41c64922ca5c", // julie.metz@hotmail.com
  "8456e025-9b8f-4c9c-a473-e219a6df3912", // metzjulie323@gmail.com
  "98f54a3e-a256-4b98-843a-d0e5a27c5a51", // metz.julie323@gmail.com (ticket record — empty)
];

async function main() {
  const admin = createAdminClient();
  for (const id of IDS) {
    const { data: c } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone, total_orders, ltv_cents, subscription_status, first_order_at, last_order_at, default_address")
      .eq("id", id)
      .maybeSingle();
    console.log(`\n\n===== ${id} =====`);
    console.log(JSON.stringify(c, null, 2));

    const { data: subs } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, status, next_billing_date, items, billing_interval, billing_interval_count")
      .eq("customer_id", id);
    console.log("--- subscriptions ---");
    for (const s of subs || []) {
      console.log(JSON.stringify({
        id: s.id, contract: s.shopify_contract_id, status: s.status, next: s.next_billing_date,
        cadence: `${s.billing_interval_count} ${s.billing_interval}`,
        items: (s.items as any[])?.map((i) => `${i.quantity}x ${i.title}${i.variant_title ? " (" + i.variant_title + ")" : ""}`),
      }));
    }
    if (!subs?.length) console.log("(no subscriptions)");

    const { data: orders } = await admin
      .from("orders")
      .select("order_number, created_at, total_cents, financial_status, line_items")
      .eq("customer_id", id)
      .order("created_at", { ascending: false })
      .limit(8);
    console.log("--- recent orders ---");
    for (const o of orders || []) {
      console.log(JSON.stringify({
        order: o.order_number, created: o.created_at, total: (o.total_cents || 0) / 100, status: o.financial_status,
        items: (o.line_items as any[])?.map((i) => `${i.quantity}x ${i.title || i.name}`),
      }));
    }
    if (!orders?.length) console.log("(no orders)");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
