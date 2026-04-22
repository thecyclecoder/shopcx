// Seed billing forecasts from current active + paused subs + dunning retries
// Run: npx tsx scripts/seed-billing-forecasts.ts
// Safe to re-run — skips subs that already have a pending forecast.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
for (const line of envFile.split("\n")) {
  const match = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.+)$/);
  if (match) process.env[match[1]] = match[2];
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const CRISIS_RESTOCK_DATE = "2026-07-08"; // Assumed Mixed Berry restock

interface SubItem {
  title: string;
  sku: string | null;
  quantity: number;
  price_cents: number;
  variant_title?: string | null;
}

function calculateRevenue(items: SubItem[]): number {
  return items
    .filter(i => i.sku !== "Insure01")
    .reduce((sum, i) => sum + (i.price_cents || 0) * (i.quantity || 1), 0);
}

function mapItems(items: SubItem[]) {
  return items.map((i) => ({
    title: i.title || "",
    sku: i.sku || null,
    quantity: i.quantity || 1,
    price_cents: i.price_cents || 0,
    variant_title: i.variant_title || null,
  }));
}

async function fetchAll(table: string, filters: Record<string, unknown>, select: string) {
  const results: any[] = [];
  let offset = 0;
  while (true) {
    let query = admin.from(table).select(select).range(offset, offset + 999);
    for (const [k, v] of Object.entries(filters)) {
      query = query.eq(k, v);
    }
    const { data } = await query;
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return results;
}

async function run() {
  const { data: ws } = await admin.from("workspaces").select("id").limit(1).single();
  if (!ws) { console.log("No workspace"); return; }
  const workspaceId = ws.id;

  // Get existing pending forecasts
  const existing = await fetchAll("billing_forecasts", { workspace_id: workspaceId, status: "pending" }, "shopify_contract_id");
  const existingContracts = new Set(existing.map((f: any) => f.shopify_contract_id));
  console.log(`Existing pending forecasts: ${existingContracts.size}\n`);

  const toInsert: any[] = [];

  // ── 1. Active subscriptions ──
  const activeSubs = await fetchAll("subscriptions", { workspace_id: workspaceId, status: "active" },
    "id, shopify_contract_id, customer_id, next_billing_date, items, billing_interval, billing_interval_count");

  let activeCount = 0;
  let activeSkipped = 0;
  for (const sub of activeSubs) {
    if (!sub.next_billing_date) continue;
    if (existingContracts.has(sub.shopify_contract_id)) { activeSkipped++; continue; }

    const items = mapItems(sub.items || []);
    toInsert.push({
      workspace_id: workspaceId,
      subscription_id: sub.id,
      shopify_contract_id: sub.shopify_contract_id,
      customer_id: sub.customer_id,
      expected_date: sub.next_billing_date.slice(0, 10),
      expected_revenue_cents: calculateRevenue(sub.items || []),
      expected_items: items,
      billing_interval: sub.billing_interval || null,
      billing_interval_count: sub.billing_interval_count || null,
      status: "pending",
      source: "seed",
      created_from: "seed",
      forecast_type: "renewal",
    });
    existingContracts.add(sub.shopify_contract_id);
    activeCount++;
  }
  console.log(`Active subs: ${activeCount} to insert, ${activeSkipped} already exist`);

  // ── 2. Paused subscriptions ──
  const pausedSubs = await fetchAll("subscriptions", { workspace_id: workspaceId, status: "paused" },
    "id, shopify_contract_id, customer_id, next_billing_date, pause_resume_at, items, billing_interval, billing_interval_count");

  // Get crisis auto_resume records
  const { data: crisisActions } = await admin
    .from("crisis_customer_actions")
    .select("customer_id, auto_resume")
    .eq("auto_resume", true);
  const crisisCustomerIds = new Set((crisisActions || []).map(c => c.customer_id));

  let pausedCount = 0;
  let pausedSkipped = 0;
  for (const sub of pausedSubs) {
    if (existingContracts.has(sub.shopify_contract_id)) { pausedSkipped++; continue; }

    // Determine expected resume/charge date
    let expectedDate: string | null = null;

    if (sub.pause_resume_at) {
      // Has a resume date — charge on resume date or next_billing_date, whichever is later
      const resumeDate = sub.pause_resume_at.slice(0, 10);
      const billingDate = sub.next_billing_date?.slice(0, 10);
      expectedDate = billingDate && billingDate > resumeDate ? billingDate : resumeDate;
    } else if (crisisCustomerIds.has(sub.customer_id)) {
      // Crisis pause — assume restock date, or next_billing_date if later
      const billingDate = sub.next_billing_date?.slice(0, 10);
      expectedDate = billingDate && billingDate > CRISIS_RESTOCK_DATE ? billingDate : CRISIS_RESTOCK_DATE;
    } else {
      // Indefinite pause — skip (shouldn't exist, we cleaned these up)
      continue;
    }

    const items = mapItems(sub.items || []);
    toInsert.push({
      workspace_id: workspaceId,
      subscription_id: sub.id,
      shopify_contract_id: sub.shopify_contract_id,
      customer_id: sub.customer_id,
      expected_date: expectedDate,
      expected_revenue_cents: calculateRevenue(sub.items || []),
      expected_items: items,
      billing_interval: sub.billing_interval || null,
      billing_interval_count: sub.billing_interval_count || null,
      status: "pending",
      source: "seed",
      created_from: "seed",
      forecast_type: "paused",
    });
    existingContracts.add(sub.shopify_contract_id);
    pausedCount++;
  }
  console.log(`Paused subs: ${pausedCount} to insert, ${pausedSkipped} already exist`);

  // ── 3. Dunning retries ──
  const dunningCycles = await fetchAll("dunning_cycles", { workspace_id: workspaceId, status: "retrying" },
    "id, shopify_contract_id, subscription_id, customer_id, next_retry_at");

  let dunningCount = 0;
  let dunningSkipped = 0;
  for (const dc of dunningCycles) {
    if (existingContracts.has(dc.shopify_contract_id)) { dunningSkipped++; continue; }
    if (!dc.next_retry_at) continue;

    // Get sub items for revenue calculation
    let items: SubItem[] = [];
    if (dc.subscription_id) {
      const { data: sub } = await admin.from("subscriptions")
        .select("items").eq("id", dc.subscription_id).single();
      items = sub?.items || [];
    }

    toInsert.push({
      workspace_id: workspaceId,
      subscription_id: dc.subscription_id,
      shopify_contract_id: dc.shopify_contract_id,
      customer_id: dc.customer_id,
      expected_date: dc.next_retry_at.slice(0, 10),
      expected_revenue_cents: calculateRevenue(items),
      expected_items: mapItems(items),
      status: "pending",
      source: "seed",
      created_from: "seed",
      forecast_type: "dunning",
    });
    existingContracts.add(dc.shopify_contract_id);
    dunningCount++;
  }
  console.log(`Dunning retries: ${dunningCount} to insert, ${dunningSkipped} already exist`);

  // ── Insert all ──
  console.log(`\nTotal to insert: ${toInsert.length}`);

  let inserted = 0;
  let errors = 0;
  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100);
    const { error } = await admin.from("billing_forecasts").insert(batch);
    if (error) {
      // Try one by one
      for (const row of batch) {
        const { error: e } = await admin.from("billing_forecasts").insert(row);
        if (e) { errors++; } else { inserted++; }
      }
    } else {
      inserted += batch.length;
    }
  }

  console.log(`Inserted: ${inserted} | Errors: ${errors}`);

  // ── Summary ──
  const { data: summary } = await admin
    .from("billing_forecasts")
    .select("expected_date, expected_revenue_cents, forecast_type, status")
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .gte("expected_date", new Date().toISOString().slice(0, 10))
    .order("expected_date", { ascending: true });

  const byDate: Record<string, { renewal: number; renewalRev: number; dunning: number; dunningRev: number; paused: number; pausedRev: number }> = {};
  for (const f of summary || []) {
    const d = f.expected_date;
    if (!byDate[d]) byDate[d] = { renewal: 0, renewalRev: 0, dunning: 0, dunningRev: 0, paused: 0, pausedRev: 0 };
    if (f.forecast_type === "dunning") {
      byDate[d].dunning++;
      byDate[d].dunningRev += f.expected_revenue_cents;
    } else if (f.forecast_type === "paused") {
      byDate[d].paused++;
      byDate[d].pausedRev += f.expected_revenue_cents;
    } else {
      byDate[d].renewal++;
      byDate[d].renewalRev += f.expected_revenue_cents;
    }
  }

  console.log("\n                 RENEWALS              DUNNING               PAUSED");
  console.log("Date       | Count |    Revenue  | Count |    Revenue  | Count |    Revenue");
  console.log("-".repeat(85));

  const dates = Object.keys(byDate).sort().slice(0, 14);
  let tR = 0, tRR = 0, tD = 0, tDR = 0, tP = 0, tPR = 0;
  for (const d of dates) {
    const b = byDate[d];
    tR += b.renewal; tRR += b.renewalRev;
    tD += b.dunning; tDR += b.dunningRev;
    tP += b.paused; tPR += b.pausedRev;
    console.log(
      `${d} | ${String(b.renewal).padStart(5)} | $${(b.renewalRev / 100).toFixed(2).padStart(10)} | ${String(b.dunning).padStart(5)} | $${(b.dunningRev / 100).toFixed(2).padStart(10)} | ${String(b.paused).padStart(5)} | $${(b.pausedRev / 100).toFixed(2).padStart(10)}`
    );
  }
  console.log("-".repeat(85));
  console.log(
    `TOTAL      | ${String(tR).padStart(5)} | $${(tRR / 100).toFixed(2).padStart(10)} | ${String(tD).padStart(5)} | $${(tDR / 100).toFixed(2).padStart(10)} | ${String(tP).padStart(5)} | $${(tPR / 100).toFixed(2).padStart(10)}`
  );
}

run().catch(console.error);
