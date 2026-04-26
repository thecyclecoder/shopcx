#!/usr/bin/env npx tsx
/**
 * Rebuild demographics_snapshots for a workspace from current
 * customer_demographics rows. Uses the same enum/logic as the Inngest
 * snapshot builder (src/lib/inngest/customer-demographics.ts).
 *
 * Usage: npx tsx scripts/rebuild-demographics-snapshot.ts <workspace_id>
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { createAdminClient } from "../src/lib/supabase/admin";

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error("Usage: npx tsx scripts/rebuild-demographics-snapshot.ts <workspace_id>");
  process.exit(1);
}
const admin = createAdminClient();

// Match Inngest snapshot builder enums exactly.
const GENDERS = ["female", "male", "unknown"] as const;
const AGE_RANGES = ["under_25", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
const INCOME_BRACKETS = ["under_40k", "40-60k", "60-80k", "80-100k", "100-125k", "125-150k", "150k+"] as const;
const URBAN_TYPES = ["urban", "suburban", "rural"] as const;
const BUYER_TYPES_LIST = ["value_buyer", "cautious_buyer", "committed_subscriber", "new_subscriber", "lapsed_subscriber", "one_time_buyer"] as const;
const CONFIDENCE_FLOOR = 0.65;

type DemoRow = {
  customer_id: string;
  inferred_gender: string | null;
  inferred_gender_conf: number | null;
  inferred_age_range: string | null;
  inferred_age_conf: number | null;
  zip_income_bracket: string | null;
  zip_urban_classification: string | null;
  buyer_type: string | null;
  health_priorities: string[] | null;
};

function emptyDist<T extends readonly string[]>(keys: T): Record<T[number], number> {
  const out = {} as Record<T[number], number>;
  for (const k of keys) out[k as T[number]] = 0;
  return out;
}

function modeOf(dist: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, v] of Object.entries(dist)) if (v > bestCount && k !== "unknown") { best = k; bestCount = v; }
  return bestCount > 0 ? best : null;
}

function computeSummary(rows: DemoRow[], totalCustomers: number) {
  const gender_distribution = emptyDist(GENDERS);
  const age_distribution = emptyDist(AGE_RANGES);
  const income_distribution = emptyDist(INCOME_BRACKETS);
  const urban_distribution = emptyDist(URBAN_TYPES);
  const buyer_type_distribution = emptyDist(BUYER_TYPES_LIST);
  const priorityCounts = new Map<string, number>();

  for (const r of rows) {
    if (r.inferred_gender && (r.inferred_gender_conf ?? 0) >= CONFIDENCE_FLOOR && (GENDERS as readonly string[]).includes(r.inferred_gender)) {
      gender_distribution[r.inferred_gender as typeof GENDERS[number]]++;
    }
    if (r.inferred_age_range && (r.inferred_age_conf ?? 0) >= CONFIDENCE_FLOOR && (AGE_RANGES as readonly string[]).includes(r.inferred_age_range)) {
      age_distribution[r.inferred_age_range as typeof AGE_RANGES[number]]++;
    }
    if (r.zip_income_bracket && (INCOME_BRACKETS as readonly string[]).includes(r.zip_income_bracket)) {
      income_distribution[r.zip_income_bracket as typeof INCOME_BRACKETS[number]]++;
    }
    if (r.zip_urban_classification && (URBAN_TYPES as readonly string[]).includes(r.zip_urban_classification)) {
      urban_distribution[r.zip_urban_classification as typeof URBAN_TYPES[number]]++;
    }
    if (r.buyer_type && (BUYER_TYPES_LIST as readonly string[]).includes(r.buyer_type)) {
      buyer_type_distribution[r.buyer_type as typeof BUYER_TYPES_LIST[number]]++;
    }
    for (const p of r.health_priorities || []) {
      if (typeof p === "string") priorityCounts.set(p, (priorityCounts.get(p) || 0) + 1);
    }
  }

  const top_health_priorities = Array.from(priorityCounts.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([priority, count]) => ({ priority, count }));

  const parts: string[] = [];
  const gMode = modeOf(gender_distribution);
  const aMode = modeOf(age_distribution);
  const iMode = modeOf(income_distribution);
  const uMode = modeOf(urban_distribution);
  const bMode = modeOf(buyer_type_distribution);
  if (gMode && aMode) parts.push(`${gMode === "female" ? "Women" : gMode === "male" ? "Men" : "Adults"} ${aMode}`);
  if (uMode) parts.push(`${uMode} households`);
  if (iMode) parts.push(`${iMode.replace("_", " ")} income`);
  if (bMode) parts.push(bMode.replace(/_/g, " "));
  if (top_health_priorities.length) parts.push(`focused on ${top_health_priorities.slice(0, 2).map(p => p.priority.replace(/_/g, " ")).join(" and ")}`);

  return {
    total_customers: totalCustomers,
    enriched_count: rows.length,
    gender_distribution, age_distribution, income_distribution, urban_distribution, buyer_type_distribution,
    top_health_priorities,
    suggested_target_customer: rows.length > 0 ? parts.join(", ") : null,
  };
}

async function main() {
  console.log(`Rebuilding demographics_snapshots for workspace ${workspaceId}\n`);
  const t0 = Date.now();

  // Load all demographics rows
  const rows: DemoRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin.from("customer_demographics")
      .select("customer_id, inferred_gender, inferred_gender_conf, inferred_age_range, inferred_age_conf, zip_income_bracket, zip_urban_classification, buyer_type, health_priorities")
      .eq("workspace_id", workspaceId)
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as DemoRow[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`Loaded ${rows.length.toLocaleString()} demographics rows`);

  // total_customers = those with orders (orders table is source of truth)
  const orderCustIds = new Set<string>();
  let oFrom = 0;
  while (true) {
    const { data, error } = await admin.from("orders")
      .select("customer_id").eq("workspace_id", workspaceId).not("customer_id", "is", null).range(oFrom, oFrom + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const o of data) if (o.customer_id) orderCustIds.add(o.customer_id as string);
    if (data.length < 1000) break;
    oFrom += 1000;
  }
  console.log(`${orderCustIds.size.toLocaleString()} customers have orders`);

  const summary = computeSummary(rows, orderCustIds.size);
  console.log(`\nincome:`, summary.income_distribution);
  console.log(`urban:`, summary.urban_distribution);
  console.log(`buyer_type:`, summary.buyer_type_distribution);
  console.log(`target customer: ${summary.suggested_target_customer}`);

  await admin.from("demographics_snapshots").upsert({
    workspace_id: workspaceId, product_id: null, ...summary, computed_at: new Date().toISOString(),
  }, { onConflict: "workspace_id" });
  console.log(`\n✓ All-customers snapshot upserted.`);

  // Per-product snapshots
  const { data: products } = await admin.from("products")
    .select("id, title, variants").eq("workspace_id", workspaceId).eq("status", "active");
  console.log(`\nBuilding per-product snapshots for ${products?.length || 0} products...`);

  // Pre-load all orders
  const allOrders: { customer_id: string; line_items: { variant_id?: string; sku?: string }[] }[] = [];
  oFrom = 0;
  while (true) {
    const { data, error } = await admin.from("orders")
      .select("customer_id, line_items").eq("workspace_id", workspaceId).range(oFrom, oFrom + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const o of data) {
      if (!o.customer_id) continue;
      allOrders.push({ customer_id: o.customer_id, line_items: (o.line_items || []) as { variant_id?: string; sku?: string }[] });
    }
    if (data.length < 1000) break;
    oFrom += 1000;
  }

  const demoByCust = new Map<string, DemoRow>();
  for (const r of rows) demoByCust.set(r.customer_id, r);

  for (const product of products || []) {
    const variants = (product.variants || []) as { id?: string; sku?: string }[];
    const variantIds = new Set(variants.map(v => String(v.id)).filter(Boolean));
    const skus = new Set(variants.map(v => v.sku).filter((s): s is string => !!s));
    if (variantIds.size === 0 && skus.size === 0) continue;

    const custIds = new Set<string>();
    for (const o of allOrders) {
      if (o.line_items.some(i => (i.variant_id && variantIds.has(String(i.variant_id))) || (i.sku && skus.has(i.sku)))) {
        custIds.add(o.customer_id);
      }
    }
    const productRows: DemoRow[] = [];
    for (const id of custIds) { const r = demoByCust.get(id); if (r) productRows.push(r); }

    const productSummary = computeSummary(productRows, custIds.size);
    await admin.from("demographics_snapshots").upsert({
      workspace_id: workspaceId, product_id: product.id, ...productSummary, computed_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,product_id" });
    console.log(`  ✓ ${product.title}: ${custIds.size} customers, ${productRows.length} enriched`);
  }

  console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
