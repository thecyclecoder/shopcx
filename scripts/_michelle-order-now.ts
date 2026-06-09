import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CONTRACT = "27835039917";
const CUSTOMER_ID = "b9adcee2-0b1e-4970-a034-c0a111d85267";
const PM_GID = "gid://shopify/CustomerPaymentMethod/acd1fc87a8d7159e3d154a5ffeeb44d9";

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { appstleSwitchPaymentMethod, appstleGetUpcomingOrders, appstleAttemptBilling, appstleUpdateNextBillingDate } = await import("../src/lib/appstle");
  const admin = createAdminClient();

  // 0. Restore local state to active (my earlier run reverted it; Appstle UI shows ACTIVE)
  await admin.from("subscriptions").update({ status: "active", updated_at: new Date().toISOString() }).eq("shopify_contract_id", CONTRACT);
  await admin.from("customers").update({ subscription_status: "active", updated_at: new Date().toISOString() }).eq("id", CUSTOMER_ID);
  console.log("local status restored → active");

  // 1. Switch to her new Visa
  const sw = await appstleSwitchPaymentMethod(WS, CONTRACT, PM_GID);
  console.log("switch card:", JSON.stringify(sw));

  // 2. Look at upcoming orders
  let orders = await appstleGetUpcomingOrders(WS, CONTRACT);
  console.log("upcoming orders:", JSON.stringify(orders.orders?.map(o => ({ id: o.id, date: o.billingDate, status: o.status }))));

  // 3. If none (stale past date), reschedule to today and re-query
  if (!orders.orders?.length) {
    const today = new Date().toISOString().slice(0, 10);
    const r = await appstleUpdateNextBillingDate(WS, CONTRACT, today);
    console.log("reschedule next billing →", today, ":", JSON.stringify(r));
    orders = await appstleGetUpcomingOrders(WS, CONTRACT);
    console.log("upcoming orders (after reschedule):", JSON.stringify(orders.orders?.map(o => ({ id: o.id, date: o.billingDate, status: o.status }))));
  }

  // 4. Bill now on the first upcoming order
  if (orders.success && orders.orders?.length) {
    const bill = await appstleAttemptBilling(WS, orders.orders[0].id);
    console.log(`attempt billing on ${orders.orders[0].id}:`, JSON.stringify(bill));
  } else {
    console.log("✗ No upcoming order to bill — could not place an order now.");
  }
})().catch(e => { console.error("ERR:", e); process.exit(1); });
