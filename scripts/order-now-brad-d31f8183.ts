/**
 * Ticket d31f8183 — "order now" for Brad's restarted 3-bag coffee sub.
 * Mirrors src/lib/portal/handlers/order-now.ts: top-orders → attempt-billing.
 * Retries on Appstle's transient "billing operation already in progress" lock
 * that follows a burst of contract mutations.
 * Contract 29952737453.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../src/lib/crypto";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const C = "29952737453";
const BASE = "https://subscription-admin.appstle.com/api/external/v2";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", WS).single();
  const apiKey = decrypt(ws!.appstle_api_key_encrypted as string);
  const H = { "X-API-Key": apiKey };

  const MAX = 8;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    // Re-read the next queued order each loop (schedule may regenerate).
    const raw = await fetch(`${BASE}/subscription-billing-attempts/top-orders?contractId=${C}`, { headers: H });
    const orders = await raw.json();
    if (!Array.isArray(orders) || !orders.length) { console.log(`[${attempt}] no upcoming orders yet, waiting…`); await sleep(15000); continue; }
    const next = orders[0];
    console.log(`[${attempt}] next order id=${next.id} billingDate=${next.billingDate} status=${next.status}`);

    const r = await fetch(`${BASE}/subscription-billing-attempts/attempt-billing/${next.id}`, { method: "PUT", headers: H });
    const body = await r.text();
    if (r.ok || r.status === 204) {
      console.log(`✓ billing attempted OK (HTTP ${r.status})`);
      console.log("response:", body.slice(0, 600));
      // Poll for the order to materialize
      for (let i = 0; i < 6; i++) {
        await sleep(8000);
        const chk = await fetch(`${BASE}/subscription-billing-attempts/top-orders?contractId=${C}`, { headers: H });
        const list = await chk.json();
        const billed = (Array.isArray(list) ? list : []).find((o: Record<string, unknown>) => o.orderName || o.orderId || o.graphOrderId);
        if (billed) { console.log("\n✅ ORDER CREATED:", JSON.stringify({ orderName: billed.orderName, orderId: billed.orderId, orderAmount: billed.orderAmount, status: billed.status, billingDate: billed.billingDate })); return; }
        console.log(`   …polling for order (${i + 1}/6)`);
      }
      console.log("\n⚠️ Billing accepted but order not yet visible in top-orders — likely still processing on Shopify side.");
      return;
    }
    const inProgress = body.includes("already in progress") || body.includes("ongoing processes");
    console.log(`   HTTP ${r.status}${inProgress ? " (lock — will retry)" : ""}: ${body.slice(0, 200)}`);
    if (!inProgress) throw new Error(`attempt-billing hard failure: ${r.status} ${body.slice(0, 300)}`);
    await sleep(15000);
  }
  throw new Error("exhausted retries — Appstle still reports a billing operation in progress");
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
