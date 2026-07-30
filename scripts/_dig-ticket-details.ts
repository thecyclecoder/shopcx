import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();

  // ===== MELISSA (ticket 2) — subscription + return + cancel-failure =====
  console.log("========== MELISSA FROBERG 710f6d2f ==========");
  const melissa = "710f6d2f-9867-465b-bb25-cc0735761ad7";

  const { data: subs } = await admin
    .from("subscriptions")
    .select("*")
    .eq("customer_id", melissa);
  console.log("\n--- subscriptions ---");
  for (const s of subs || []) console.log(JSON.stringify(s, null, 2));

  const { data: returns } = await admin
    .from("returns")
    .select("*")
    .eq("customer_id", melissa)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log("\n--- returns ---");
  for (const r of returns || []) console.log(JSON.stringify(r, null, 2));

  // Recent agent action queue rows for this ticket (the failed cancel)
  const { data: aq } = await admin
    .from("agent_action_queue")
    .select("*")
    .eq("ticket_id", "eca3f43b-a59d-4081-8a40-be84e6e4ada7")
    .order("created_at", { ascending: false })
    .limit(20);
  console.log("\n--- agent_action_queue (ticket 2) ---");
  for (const a of aq || []) console.log(JSON.stringify(a, null, 2));

  // ===== JULIE (ticket 1) — can we locate her under another identity? =====
  console.log("\n\n========== JULIE METZ locate ==========");
  console.log("email on ticket: metz.julie323@gmail.com  addr: 6225 Hwy 46 / HWY 45 SE, Gackle, ND 58442");

  const { data: byName } = await admin
    .from("customers")
    .select("id, email, first_name, last_name, phone, created_at")
    .or("first_name.ilike.%julie%,last_name.ilike.%metz%")
    .limit(30);
  console.log("\n--- customers matching name julie/metz ---");
  for (const c of byName || []) console.log(JSON.stringify(c));

  // Search orders by shipping address city/state or name
  const { data: ordByAddr } = await admin
    .from("orders")
    .select("id, order_number, customer_id, email, shipping_address, total_price, created_at")
    .or("email.ilike.%metz%")
    .limit(30);
  console.log("\n--- orders with email like metz ---");
  for (const o of ordByAddr || []) console.log(JSON.stringify(o));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
