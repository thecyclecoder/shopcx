import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();

  // What address columns exist on customers?
  const { data: sampleCust } = await admin.from("customers").select("*").limit(1);
  console.log("=== customers columns ===");
  console.log(Object.keys(sampleCust?.[0] || {}).join(", "));

  const { data: sampleOrd } = await admin.from("orders").select("*").limit(1);
  console.log("\n=== orders columns ===");
  console.log(Object.keys(sampleOrd?.[0] || {}).join(", "));

  // 1) Orders by ZIP 58442 (most reliable — city/street spelling varies)
  console.log("\n=== orders shipping zip 58442 ===");
  const { data: byZip } = await admin
    .from("orders")
    .select("id, order_number, customer_id, email, shipping_address, total_price, created_at")
    .or("shipping_address->>zip.ilike.%58442%,shipping_address->>postal_code.ilike.%58442%,shipping_address->>zipCode.ilike.%58442%")
    .limit(40);
  for (const o of byZip || []) console.log(JSON.stringify({ order: o.order_number, email: o.email, cust: o.customer_id, addr: o.shipping_address, created: o.created_at }));
  if (!byZip?.length) console.log("(none)");

  // 2) Orders by street number 6225 or highway 46/45
  console.log("\n=== orders shipping address1 like 6225 / hwy 4 ===");
  const { data: byStreet } = await admin
    .from("orders")
    .select("id, order_number, customer_id, email, shipping_address, created_at")
    .or("shipping_address->>address1.ilike.%6225%,shipping_address->>address1.ilike.%gackle%")
    .limit(40);
  for (const o of byStreet || []) console.log(JSON.stringify({ order: o.order_number, email: o.email, cust: o.customer_id, addr: o.shipping_address }));
  if (!byStreet?.length) console.log("(none)");

  // 3) Customers with an address column matching
  console.log("\n=== customers address-ish match (58442 / gackle / 6225) ===");
  const cols = Object.keys(sampleCust?.[0] || {});
  const addrCols = cols.filter((c) => /address|city|state|zip|postal|province/i.test(c));
  console.log("address-ish customer cols:", addrCols.join(", ") || "(none)");
  for (const col of addrCols) {
    for (const needle of ["58442", "gackle", "6225"]) {
      const { data } = await admin.from("customers").select("id, email, first_name, last_name").ilike(col, `%${needle}%`).limit(10);
      if (data?.length) {
        console.log(`  match on ${col} ~ ${needle}:`);
        for (const c of data) console.log("   ", JSON.stringify(c));
      }
    }
  }

  // 4) Any order at all in North Dakota (small state — list them)
  console.log("\n=== ALL orders shipping to ND (province/state = ND) ===");
  const { data: ndAll } = await admin
    .from("orders")
    .select("id, order_number, customer_id, email, shipping_address")
    .or("shipping_address->>provinceCode.eq.ND,shipping_address->>province.ilike.%dakota%,shipping_address->>province_code.eq.ND,shipping_address->>state.ilike.%dakota%,shipping_address->>state.eq.ND")
    .limit(60);
  for (const o of ndAll || []) {
    const a: any = o.shipping_address || {};
    console.log(JSON.stringify({ order: o.order_number, email: o.email, name: `${a.firstName||a.first_name||a.name||""} ${a.lastName||a.last_name||""}`.trim(), city: a.city, zip: a.zip||a.postal_code, addr: a.address1 }));
  }
  if (!ndAll?.length) console.log("(none)");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
