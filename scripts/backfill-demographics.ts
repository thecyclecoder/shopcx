#!/usr/bin/env npx tsx
/**
 * Backfill customer_demographics from a clean state. Replaces the Inngest job
 * for one-shot bulk runs (619K+ customers).
 *
 * - Cursor-paginated by customers.id ascending — no offset
 * - Skips customers that already have a demographics row at the current version
 * - Batches name inference per chunk via Claude Haiku
 * - Census zip lookup uses the existing cache (zip_demographics_cache table)
 * - Skips Versium (no API key configured)
 * - Resumable: re-running just continues from where the last skipped row was
 *
 * Usage:
 *   npx tsx scripts/backfill-demographics.ts <workspace_id>
 *   npx tsx scripts/backfill-demographics.ts <workspace_id> --chunk 500 --max 50000
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load env BEFORE importing app modules
const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

import { createAdminClient } from "../src/lib/supabase/admin";
import { decrypt } from "../src/lib/crypto";
import { fetchZipDemographics, timezoneFromState } from "../src/lib/census";
import {
import { HAIKU_MODEL } from "../src/lib/ai-models";
  analyzeOrderHistory, lifeStageFromAgeRange,
  type AgeRange, type OrderInput, type SubscriptionInput,
} from "../src/lib/customer-demographics";

const HAIKU = HAIKU_MODEL;
const ENRICHMENT_VERSION = 1;
const CONFIDENCE_FLOOR_FOR_GENDER = 0.6;

// CLI args
const args = process.argv.slice(2);
const workspaceId = args[0];
if (!workspaceId) {
  console.error("Usage: npx tsx scripts/backfill-demographics.ts <workspace_id> [--chunk N] [--max N]");
  process.exit(1);
}
const chunkSize = Number(args[args.indexOf("--chunk") + 1]) || 500;
const maxToProcess = Number(args[args.indexOf("--max") + 1]) || Infinity;

const admin = createAdminClient();

// ── Helpers ──

interface NameInference {
  gender: "female" | "male" | "unknown";
  gender_confidence: number;
  age_range: AgeRange;
  age_confidence: number;
  notes?: string;
}

async function callHaiku(system: string, user: string, maxTokens = 4096): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: HAIKU, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) {
    console.warn(`  Haiku ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return ((data.content as { type: string; text?: string }[]) || [])
    .map(b => b.type === "text" ? b.text || "" : "").join("").trim() || null;
}

function extractJsonArray<T>(text: string): T[] | null {
  if (!text) return null;
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  try { const parsed = JSON.parse(cleaned); return Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

function clamp(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeAge(r: unknown): AgeRange | null {
  const valid: AgeRange[] = ["under_25", "25-34", "35-44", "45-54", "55-64", "65+"];
  return typeof r === "string" && valid.includes(r as AgeRange) ? r as AgeRange : null;
}

async function inferNamesBatch(firstNames: string[]): Promise<Map<string, NameInference>> {
  const out = new Map<string, NameInference>();
  const unique = Array.from(new Set(firstNames.map(n => (n || "").trim()).filter(Boolean)));
  if (unique.length === 0) return out;

  const system = `You are inferring demographic attributes from first names only. Never infer race, ethnicity, or national origin. Respond with strict JSON only — no prose, no markdown fences.`;
  const user = `For each first name below, infer gender and age range based on US name popularity data. Return a JSON array with one object per name, in the same order. Return exactly ${unique.length} results.

Names:
${unique.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Output schema:
[{"name":"string","gender":"female"|"male"|"unknown","gender_confidence":0.0-1.0,"age_range":"under_25"|"25-34"|"35-44"|"45-54"|"55-64"|"65+","age_confidence":0.0-1.0,"notes":"brief reasoning"}]

Guidelines:
- gender_confidence >= 0.85 = strong (Linda, Barbara, Michael, James)
- gender_confidence 0.6-0.84 = moderate
- gender_confidence < 0.6 = use "unknown" for gender
- age_confidence >= 0.7 = name peaked in specific decade
- Never infer race, ethnicity, or national origin`;

  const text = await callHaiku(system, user);
  if (!text) return out;
  const parsed = extractJsonArray<{ name: string; gender: string; gender_confidence: number; age_range: string; age_confidence: number; notes?: string }>(text);
  if (!parsed) return out;

  for (let i = 0; i < parsed.length && i < unique.length; i++) {
    const r = parsed[i];
    if (!r) continue;
    const gender = r.gender === "female" || r.gender === "male" ? r.gender : "unknown";
    const gender_confidence = clamp(r.gender_confidence);
    out.set(unique[i].toLowerCase(), {
      gender: gender_confidence < CONFIDENCE_FLOOR_FOR_GENDER ? "unknown" : gender,
      gender_confidence,
      age_range: normalizeAge(r.age_range) || "35-44",
      age_confidence: clamp(r.age_confidence),
      notes: typeof r.notes === "string" ? r.notes : "",
    });
  }
  return out;
}

async function getCensusKey(): Promise<string | undefined> {
  const { data } = await admin.from("workspaces").select("census_api_key_encrypted").eq("id", workspaceId).single();
  if (!data?.census_api_key_encrypted) return undefined;
  try { return decrypt(data.census_api_key_encrypted); } catch { return undefined; }
}

interface Customer {
  id: string;
  workspace_id: string;
  first_name: string | null;
  default_address: Record<string, unknown> | null;
  email?: string;
  last_name?: string | null;
  total_orders?: number;
}

function extractZip(c: Customer): string | null {
  const addr = c.default_address;
  if (!addr) return null;
  const z = (addr.zip ?? addr.postal_code ?? addr.postalCode ?? "") as string;
  return typeof z === "string" && z.trim() ? z.trim() : null;
}

function extractState(c: Customer): string | null {
  const addr = c.default_address;
  if (!addr) return null;
  const s = (addr.province_code ?? addr.state_code ?? addr.state ?? "") as string;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

async function loadOrdersAndSubs(customerId: string): Promise<{ orders: OrderInput[]; subscriptions: SubscriptionInput[] }> {
  const [ordersRes, subsRes] = await Promise.all([
    admin.from("orders").select("total_cents, created_at, line_items").eq("workspace_id", workspaceId).eq("customer_id", customerId),
    admin.from("subscriptions").select("status, created_at, items").eq("workspace_id", workspaceId).eq("customer_id", customerId),
  ]);
  return {
    orders: (ordersRes.data || []).map(o => ({
      total_cents: typeof o.total_cents === "number" ? o.total_cents : Number(o.total_cents) || 0,
      created_at: o.created_at,
      line_items: Array.isArray(o.line_items) ? o.line_items : [],
    })),
    subscriptions: (subsRes.data || []).map(s => ({ status: s.status, created_at: s.created_at, items: s.items })),
  };
}

async function enrichOne(c: Customer, nameMap: Map<string, NameInference>, censusKey: string | undefined): Promise<void> {
  const nameKey = (c.first_name || "").toLowerCase().trim();
  const nameResult = nameKey ? nameMap.get(nameKey) : undefined;

  const zip = extractZip(c);
  const zipData = zip ? await fetchZipDemographics(zip, censusKey) : null;

  const stateCode = extractState(c) || zipData?.state || null;
  const timezone = timezoneFromState(stateCode);
  if (timezone) {
    await admin.from("customers").update({ timezone }).eq("id", c.id);
  }

  const { orders, subscriptions } = await loadOrdersAndSubs(c.id);
  const orderAnalysis = analyzeOrderHistory(orders, subscriptions);

  const ageRange = nameResult?.age_range ?? null;
  const gender = nameResult?.gender ?? "unknown";
  const lifeStage = lifeStageFromAgeRange(ageRange);

  await admin.from("customer_demographics").upsert({
    customer_id: c.id,
    workspace_id: c.workspace_id,
    inferred_gender: gender,
    inferred_gender_conf: nameResult?.gender_confidence ?? 0,
    inferred_age_range: ageRange,
    inferred_age_conf: nameResult?.age_confidence ?? 0,
    name_inference_notes: nameResult?.notes ?? null,
    zip_code: zip,
    zip_median_income: zipData?.median_income ?? null,
    zip_median_age: zipData?.median_age ?? null,
    zip_income_bracket: zipData?.income_bracket ?? null,
    zip_urban_classification: zipData?.urban_classification ?? null,
    zip_owner_pct: zipData?.owner_pct ?? null,
    zip_college_pct: zipData?.college_pct ?? null,
    versium_interests: [],
    inferred_life_stage: lifeStage,
    health_priorities: orderAnalysis.health_priorities,
    buyer_type: orderAnalysis.buyer_type,
    total_orders: orderAnalysis.total_orders,
    total_spend_cents: orderAnalysis.total_spend_cents,
    subscription_tenure_days: orderAnalysis.subscription_tenure_days,
    enriched_at: new Date().toISOString(),
    enrichment_version: ENRICHMENT_VERSION,
    census_data_year: zipData?.acs_year ?? null,
  }, { onConflict: "customer_id" });
}

// ── Main loop ──

async function loadCustomerIdsWithOrders(): Promise<string[]> {
  // Source of truth = orders table. customers.total_orders is unreliable
  // (gets zeroed by Shopify customer/update webhooks with missing fields).
  const ids = new Set<string>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("orders")
      .select("customer_id")
      .eq("workspace_id", workspaceId)
      .not("customer_id", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const o of data) if (o.customer_id) ids.add(o.customer_id as string);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return [...ids].sort();
}

async function main() {
  const censusKey = await getCensusKey();

  console.log("Loading customer ids with orders from orders table...");
  const t_load = Date.now();
  const customerIds = await loadCustomerIdsWithOrders();
  console.log(`Loaded ${customerIds.length.toLocaleString()} distinct customer ids in ${Math.round((Date.now() - t_load) / 1000)}s`);

  const { count: enrichedCount } = await admin.from("customer_demographics").select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId).gte("enrichment_version", ENRICHMENT_VERSION);
  console.log(`Already enriched (v${ENRICHMENT_VERSION}+): ${enrichedCount}`);
  console.log(`Pending: ~${customerIds.length - (enrichedCount || 0)}`);
  console.log(`Census key: ${censusKey ? "configured" : "missing (zip lookups limited)"}`);
  console.log(`Chunk size: ${chunkSize}   Max to process: ${maxToProcess === Infinity ? "unlimited" : maxToProcess}\n`);

  let totalProcessed = 0;
  let totalEnriched = 0;
  let totalSkipped = 0;
  const t0 = Date.now();

  for (let offset = 0; offset < customerIds.length && totalEnriched < maxToProcess; offset += chunkSize) {
    const chunkIds = customerIds.slice(offset, offset + chunkSize);

    const { data: rows, error } = await admin
      .from("customers")
      .select("id, workspace_id, first_name, last_name, email, default_address")
      .in("id", chunkIds);
    if (error) throw error;
    if (!rows || rows.length === 0) continue;

    // Filter out already-enriched
    const { data: existing } = await admin.from("customer_demographics")
      .select("customer_id, enrichment_version")
      .in("customer_id", chunkIds);
    const skip = new Set((existing || []).filter(e => (e.enrichment_version || 0) >= ENRICHMENT_VERSION).map(e => e.customer_id));
    const todo = rows.filter(r => !skip.has(r.id)) as Customer[];
    totalSkipped += rows.length - todo.length;
    const cursor = chunkIds[chunkIds.length - 1];

    if (todo.length === 0) {
      totalProcessed += rows.length;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const rate = totalProcessed / Math.max(1, elapsed);
      process.stdout.write(`\rprocessed ${totalProcessed.toLocaleString()}  enriched ${totalEnriched.toLocaleString()}  skipped ${totalSkipped.toLocaleString()}  ${rate.toFixed(1)} c/s  cursor ${cursor.slice(0, 8)}`);
      continue;
    }

    // Batch infer names for this chunk
    const firstNames = todo.map(c => c.first_name).filter((n): n is string => typeof n === "string" && n.trim().length > 0);
    const nameMap = await inferNamesBatch(firstNames);

    // Enrich each (parallel within chunk for throughput)
    await Promise.all(todo.map(c => enrichOne(c, nameMap, censusKey).catch(e => {
      console.warn(`\n  failed ${c.id}: ${e instanceof Error ? e.message : e}`);
    })));

    totalProcessed += rows.length;
    totalEnriched += todo.length;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const rate = totalProcessed / Math.max(1, elapsed);
    process.stdout.write(`\rprocessed ${totalProcessed.toLocaleString()}  enriched ${totalEnriched.toLocaleString()}  skipped ${totalSkipped.toLocaleString()}  ${rate.toFixed(1)} c/s  cursor ${cursor.slice(0, 8)}`);
  }

  console.log(`\n\nFinal: processed ${totalProcessed.toLocaleString()}  enriched ${totalEnriched.toLocaleString()}  skipped ${totalSkipped.toLocaleString()}  in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
