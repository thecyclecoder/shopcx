/**
 * Wiki-validation suite — one script per join path we care about.
 *
 * Convention: each `scripts/wiki-validate-*.ts` answers a real
 * question using ONLY what docs/brain/tables/*.md says — no DB
 * probing, no grep. When a script fails or returns wrong results,
 * patch the wiki page that misled you, then re-run.
 *
 * This one: "list all subs in active dunning + the most recent
 * payment failure for each."
 *
 * Tables exercised:
 *   - [[tables/dunning_cycles]]    (status='active', lowercase)
 *   - [[tables/payment_failures]]  (most recent attempt per sub)
 *   - [[tables/subscriptions]]     (sub status + items)
 *   - [[tables/customers]]         (display only)
 *
 * Gotchas the wiki was patched to surface after this test:
 *   - Internal joins use the UUID, never shopify_contract_id.
 *   - dunning_cycles.status / subscriptions.status are lowercase.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  // 1. Active dunning cycles (status is lowercase per the wiki gotcha)
  const { data: cycles } = await sb.from("dunning_cycles")
    .select("id, subscription_id, shopify_contract_id, customer_id, cycle_number, created_at, next_retry_at, cards_tried, last_attempted_last4")
    .eq("workspace_id", WS)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (!cycles?.length) { console.log("No active dunning cycles."); return; }
  console.log(`Active dunning cycles: ${cycles.length}\n`);

  // 2. For each: subscription + most recent failure attempt.
  //    Internal joins ALWAYS use the UUID (Shopify is being sunset and
  //    shopify_contract_id goes away). For any cycle without a
  //    subscription_id, that's a data issue we want to surface — flag
  //    and skip rather than silently fall back to the Shopify id.
  for (const c of cycles) {
    if (!c.subscription_id) {
      console.log(`--- cycle ${c.cycle_number} | ${c.shopify_contract_id} — MISSING subscription_id UUID, skipping ---\n`);
      continue;
    }
    const [subQ, failQ, custQ] = await Promise.all([
      sb.from("subscriptions")
        .select("status, items, next_billing_date, delivery_price_cents")
        .eq("id", c.subscription_id).maybeSingle(),
      sb.from("payment_failures")
        .select("attempt_number, attempt_type, error_code, error_message, payment_method_last4, succeeded, created_at")
        .eq("workspace_id", WS)
        .eq("subscription_id", c.subscription_id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      c.customer_id
        ? sb.from("customers").select("email, first_name, last_name").eq("id", c.customer_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const sub = subQ.data;
    const fail = failQ.data;
    const cust = custQ.data;
    const items = (sub?.items as Array<{ title?: string; variant_title?: string; quantity?: number }> | undefined) || [];
    const itemStr = items.map(i => `${i.quantity}× ${i.title}${i.variant_title ? ` [${i.variant_title}]` : ""}`).join(", ") || "(no items)";
    const custStr = cust ? `${cust.first_name || ""} ${cust.last_name || ""} <${cust.email}>`.trim() : "(no customer)";

    console.log(`--- cycle ${c.cycle_number} | ${c.shopify_contract_id} ---`);
    console.log(`  customer:    ${custStr}`);
    console.log(`  sub status:  ${sub?.status || "?"} | next bill: ${sub?.next_billing_date?.slice(0, 10) || "?"} | ${itemStr}`);
    console.log(`  cycle since: ${c.created_at?.slice(0, 10)} | next retry: ${c.next_retry_at?.slice(0, 16) || "—"}`);
    console.log(`  cards tried: ${(c.cards_tried as string[] | null)?.join(", ") || "—"} | last attempt last4: ${c.last_attempted_last4 || "—"}`);
    if (fail) {
      console.log(`  LATEST FAIL: ${fail.created_at?.slice(0, 16)} | type=${fail.attempt_type} | attempt #${fail.attempt_number} | last4=${fail.payment_method_last4 || "—"}`);
      console.log(`               error: ${fail.error_code || "—"} — ${fail.error_message || "—"}`);
    } else {
      console.log(`  LATEST FAIL: (none in payment_failures yet)`);
    }
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
