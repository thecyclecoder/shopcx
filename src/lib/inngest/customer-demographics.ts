/**
 * Customer demographic enrichment orchestrators.
 *
 * Two functions:
 *   - demographics/enrich-batch (nightly + on-demand): processes up to 500
 *     unenriched customers per invocation, self-continues.
 *   - demographics/enrich-single (event-driven, ~1h delayed): enriches a
 *     single customer shortly after their profile is created/updated.
 *
 * Three enrichment tracks run per customer:
 *   1. Name → gender + age range via Claude Haiku (batched).
 *   2. Zip code → income / urban / education via Census API (cached).
 *   3. Order history → buyer type / health priorities / spend (pure logic).
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { fetchZipDemographics, timezoneFromState } from "@/lib/census";
import { fetchVersiumDemographics } from "@/lib/versium";
import {
  analyzeOrderHistory,
  lifeStageFromAgeRange,
  type AgeRange,
  type OrderInput,
  type SubscriptionInput,
} from "@/lib/customer-demographics";
import { HAIKU_MODEL } from "@/lib/ai-models";

const HAIKU = HAIKU_MODEL;
const ENRICHMENT_VERSION = 1;
const BATCH_SIZE = 50;
const MAX_PER_RUN = 500;
const CONFIDENCE_FLOOR_FOR_GENDER = 0.6;

type AnthropicContentBlock = { type: string; text?: string };

type NameInferenceResult = {
  name: string;
  gender: "female" | "male" | "unknown";
  gender_confidence: number;
  age_range: AgeRange;
  age_confidence: number;
  notes?: string;
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function callHaiku(
  system: string,
  user: string,
  maxTokens = 4096,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return (
    ((data.content as AnthropicContentBlock[]) || [])
      .map((b) => (b.type === "text" ? b.text || "" : ""))
      .join("")
      .trim() || null
  );
}

function extractJsonArray<T>(text: string): T[] | null {
  if (!text) return null;
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeAgeRange(r: unknown): AgeRange | null {
  const valid: AgeRange[] = ["under_25", "25-34", "35-44", "45-54", "55-64", "65+"];
  if (typeof r !== "string") return null;
  return valid.includes(r as AgeRange) ? (r as AgeRange) : null;
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

type CustomerShape = {
  id: string;
  workspace_id: string;
  first_name: string | null;
  default_address: Record<string, unknown> | null;
};

function extractZip(customer: CustomerShape): string | null {
  const addr = customer.default_address as Record<string, unknown> | null | undefined;
  if (!addr) return null;
  const zip = (addr.zip ?? addr.postal_code ?? addr.postalCode ?? "") as string;
  return typeof zip === "string" && zip.trim().length > 0 ? zip.trim() : null;
}

function extractStateCode(customer: CustomerShape): string | null {
  const addr = customer.default_address as Record<string, unknown> | null | undefined;
  if (!addr) return null;
  const state = (addr.province_code ?? addr.state_code ?? addr.state ?? "") as string;
  return typeof state === "string" && state.trim().length > 0 ? state.trim() : null;
}

async function getCensusApiKey(workspaceId: string): Promise<string | undefined> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("census_api_key_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!data?.census_api_key_encrypted) return undefined;
  try {
    return decrypt(data.census_api_key_encrypted);
  } catch {
    return undefined;
  }
}

// Batched Claude name inference. Returns map of lowercased name → result.
async function inferNamesBatch(
  firstNames: string[],
): Promise<Map<string, NameInferenceResult>> {
  const map = new Map<string, NameInferenceResult>();
  const unique = Array.from(
    new Set(firstNames.map((n) => (n || "").trim()).filter((n) => n.length > 0)),
  );
  if (unique.length === 0) return map;

  const system = `You are inferring demographic attributes from first names only. Never infer race, ethnicity, or national origin. Respond with strict JSON only — no prose, no markdown fences.`;

  const user = `For each first name below, infer gender and age range based on US name popularity data. Return a JSON array with one object per name, in the same order. Return exactly ${unique.length} results.

Names:
${unique.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Output schema:
[{
  "name": "string",
  "gender": "female" | "male" | "unknown",
  "gender_confidence": 0.0-1.0,
  "age_range": "under_25" | "25-34" | "35-44" | "45-54" | "55-64" | "65+",
  "age_confidence": 0.0-1.0,
  "notes": "brief reasoning"
}]

Guidelines:
- gender_confidence >= 0.85 = strong (Linda, Barbara, Michael, James)
- gender_confidence 0.6-0.84 = moderate
- gender_confidence < 0.6 = use "unknown" for gender
- age_confidence >= 0.7 = name peaked in specific decade (Linda peaked 1940s-50s → 65+)
- age_confidence < 0.5 = too common across decades or too rare
- Never infer race, ethnicity, or national origin`;

  const text = await callHaiku(system, user, 4096);
  if (!text) return map;
  const parsed = extractJsonArray<NameInferenceResult>(text);
  if (!parsed) return map;

  for (let i = 0; i < parsed.length && i < unique.length; i++) {
    const raw = parsed[i];
    if (!raw || typeof raw !== "object") continue;
    const gender: "female" | "male" | "unknown" =
      raw.gender === "female" || raw.gender === "male" ? raw.gender : "unknown";
    const gender_confidence = clampConfidence(raw.gender_confidence);
    const age_range = normalizeAgeRange(raw.age_range);
    const age_confidence = clampConfidence(raw.age_confidence);

    const result: NameInferenceResult = {
      name: unique[i],
      gender: gender_confidence < CONFIDENCE_FLOOR_FOR_GENDER ? "unknown" : gender,
      gender_confidence,
      age_range: age_range || "35-44",
      age_confidence,
      notes: typeof raw.notes === "string" ? raw.notes : "",
    };
    map.set(unique[i].toLowerCase(), result);
  }
  return map;
}

async function loadOrdersAndSubs(
  workspaceId: string,
  customerId: string,
): Promise<{ orders: OrderInput[]; subscriptions: SubscriptionInput[] }> {
  const admin = createAdminClient();

  const [ordersRes, subsRes] = await Promise.all([
    admin
      .from("orders")
      .select("total_cents, created_at, line_items")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId),
    admin
      .from("subscriptions")
      .select("status, created_at, items")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId),
  ]);

  const orders = (ordersRes.data || []).map((o) => ({
    total_cents: typeof o.total_cents === "number" ? o.total_cents : Number(o.total_cents) || 0,
    created_at: o.created_at,
    line_items: Array.isArray(o.line_items) ? o.line_items : [],
  }));

  const subscriptions = (subsRes.data || []).map((s) => ({
    status: s.status,
    created_at: s.created_at,
    items: s.items,
  }));

  return { orders, subscriptions };
}

async function enrichOne(
  customer: CustomerShape,
  nameMap: Map<string, NameInferenceResult>,
  apiKey: string | undefined,
): Promise<void> {
  const admin = createAdminClient();

  const nameKey = (customer.first_name || "").toLowerCase().trim();
  const nameResult = nameKey ? nameMap.get(nameKey) : undefined;

  const zip = extractZip(customer);
  const zipData = zip ? await fetchZipDemographics(zip, apiKey) : null;

  // Derive timezone from state code — try customer address, fall back to zip cache state
  const stateCode = extractStateCode(customer) || zipData?.state || null;
  const timezone = timezoneFromState(stateCode);
  if (timezone) {
    await admin.from("customers").update({ timezone }).eq("id", customer.id);
  }

  // Track 3: Versium (if configured)
  const addr = customer.default_address as Record<string, unknown> | null;
  const versium = await fetchVersiumDemographics(customer.workspace_id, {
    email: (customer as Record<string, unknown>).email as string | undefined,
    first_name: customer.first_name || undefined,
    last_name: (customer as Record<string, unknown>).last_name as string | undefined,
    address: (addr?.address1 as string) || undefined,
    city: (addr?.city as string) || undefined,
    state: (addr?.province_code as string) || (addr?.state as string) || undefined,
    zip: zip || undefined,
  });

  const { orders, subscriptions } = await loadOrdersAndSubs(
    customer.workspace_id,
    customer.id,
  );
  const orderAnalysis = analyzeOrderHistory(orders, subscriptions);

  // Use Versium data when available, fall back to Haiku inference
  const ageRange = versium?.age_range ?? nameResult?.age_range ?? null;
  const gender = versium?.gender ?? nameResult?.gender ?? "unknown";
  const lifeStage = lifeStageFromAgeRange(ageRange as Parameters<typeof lifeStageFromAgeRange>[0]);

  // Build Versium interests array from boolean flags
  const versiumInterests: string[] = [];
  if (versium) {
    if (versium.interest_health_beauty) versiumInterests.push("health_beauty");
    if (versium.interest_exercise) versiumInterests.push("exercise");
    if (versium.interest_diet_weight_loss) versiumInterests.push("diet_weight_loss");
    if (versium.interest_vitamins) versiumInterests.push("vitamins");
    if (versium.interest_cooking) versiumInterests.push("cooking");
    if (versium.interest_travel) versiumInterests.push("travel");
    if (versium.interest_pets) versiumInterests.push("pets");
    if (versium.interest_gardening) versiumInterests.push("gardening");
    if (versium.interest_reading) versiumInterests.push("reading");
    if (versium.online_purchasing) versiumInterests.push("online_purchasing");
  }

  await admin
    .from("customer_demographics")
    .upsert(
      {
        customer_id: customer.id,
        workspace_id: customer.workspace_id,

        inferred_gender: gender,
        inferred_gender_conf: versium?.gender ? 1.0 : (nameResult?.gender_confidence ?? 0),
        inferred_age_range: ageRange,
        inferred_age_conf: versium?.age_range ? 1.0 : (nameResult?.age_confidence ?? 0),
        name_inference_notes: nameResult?.notes ?? null,

        zip_code: zip,
        zip_median_income: zipData?.median_income ?? null,
        zip_median_age: zipData?.median_age ?? null,
        zip_income_bracket: zipData?.income_bracket ?? null,
        zip_urban_classification: zipData?.urban_classification ?? null,
        zip_owner_pct: zipData?.owner_pct ?? null,
        zip_college_pct: zipData?.college_pct ?? null,

        // Versium fields
        versium_gender: versium?.gender ?? null,
        versium_age_range: versium?.age_range ?? null,
        versium_household_income: versium?.household_income ?? null,
        versium_net_worth: versium?.estimated_net_worth ?? null,
        versium_education: versium?.education_level ?? null,
        versium_marital_status: versium?.marital_status ?? null,
        versium_home_owner: versium?.home_owner ?? null,
        versium_home_value: versium?.home_market_value ?? null,
        versium_household_size: versium?.household_size ?? null,
        versium_presence_of_children: versium?.presence_of_children ?? null,
        versium_interests: versiumInterests.length ? versiumInterests : [],
        versium_raw: versium?.raw ?? null,
        versium_enriched_at: versium ? new Date().toISOString() : null,

        inferred_life_stage: lifeStage,
        health_priorities: orderAnalysis.health_priorities,
        buyer_type: orderAnalysis.buyer_type,
        total_orders: orderAnalysis.total_orders,
        total_spend_cents: orderAnalysis.total_spend_cents,
        subscription_tenure_days: orderAnalysis.subscription_tenure_days,

        enriched_at: new Date().toISOString(),
        enrichment_version: ENRICHMENT_VERSION,
        census_data_year: zipData?.acs_year ?? null,
      },
      { onConflict: "customer_id" },
    );
}

// ----------------------------------------------------------------------------
// 5a. enrich-batch
// ----------------------------------------------------------------------------

export const enrichBatch = inngest.createFunction(
  {
    id: "demographics-enrich-batch",
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 6 * * *" },
      { event: "demographics/enrich-batch" },
    ],
  },
  async ({ event, step }) => {
    const eventData = (event?.data || {}) as {
      workspace_id?: string;
      force_all?: boolean;
    };

    const workspaceIds = await step.run("select-workspaces", async () => {
      const admin = createAdminClient();
      if (eventData.workspace_id) return [eventData.workspace_id];
      const { data } = await admin.from("workspaces").select("id");
      return (data || []).map((w) => w.id);
    });

    let totalEnriched = 0;
    let totalRemaining = 0;

    for (const workspaceId of workspaceIds) {
      const customers = await step.run(
        `fetch-unenriched-${workspaceId}`,
        async () => {
          const admin = createAdminClient();
          // Customers missing demographics or with old version — only those with orders
          let query = admin
            .from("customers")
            .select("id, workspace_id, first_name, default_address")
            .eq("workspace_id", workspaceId)
            .gt("total_orders", 0)
            .limit(MAX_PER_RUN);

          if (!eventData.force_all) {
            // Only pick customers with no demographics row OR outdated version.
            // Supabase JS can't do a LEFT JOIN in one query, so we'll over-
            // fetch and filter client-side by checking existing rows.
            // This is fine at MAX_PER_RUN scale.
            const { data: existing } = await admin
              .from("customer_demographics")
              .select("customer_id, enrichment_version")
              .eq("workspace_id", workspaceId);
            const skipIds = new Set(
              (existing || [])
                .filter(
                  (e) => (e.enrichment_version || 0) >= ENRICHMENT_VERSION,
                )
                .map((e) => e.customer_id),
            );
            const { data: all } = await query;
            return (all || []).filter((c) => !skipIds.has(c.id)).slice(0, MAX_PER_RUN);
          }

          const { data } = await query;
          return data || [];
        },
      );

      // Determine how much remains after this run
      const remaining = await step.run(
        `count-remaining-${workspaceId}`,
        async () => {
          const admin = createAdminClient();
          const { count: totalCustomers } = await admin
            .from("customers")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .gt("total_orders", 0);
          const { count: enrichedCount } = await admin
            .from("customer_demographics")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .gte("enrichment_version", ENRICHMENT_VERSION);
          return Math.max(0, (totalCustomers || 0) - (enrichedCount || 0));
        },
      );

      if (customers.length === 0) {
        totalRemaining += remaining;
        continue;
      }

      const apiKey = await step.run(`census-key-${workspaceId}`, async () =>
        (await getCensusApiKey(workspaceId)) || null,
      );

      // Process in chunks of BATCH_SIZE so each Claude call stays reasonable
      for (let offset = 0; offset < customers.length; offset += BATCH_SIZE) {
        const chunk = customers.slice(offset, offset + BATCH_SIZE);

        await step.run(`enrich-${workspaceId}-${offset}`, async () => {
          const firstNames = chunk
            .map((c) => c.first_name)
            .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
          const nameMap = await inferNamesBatch(firstNames);

          for (const customer of chunk) {
            try {
              await enrichOne(customer as CustomerShape, nameMap, apiKey || undefined);
            } catch (err) {
              console.error("enrich-batch: failed customer", customer.id, err);
            }
          }
        });
      }

      totalEnriched += customers.length;

      // If still more to process, self-continue
      const newRemaining = Math.max(0, remaining - customers.length);
      if (newRemaining > 0) {
        await step.sendEvent(`continue-${workspaceId}`, {
          name: "demographics/enrich-batch",
          data: { workspace_id: workspaceId, force_all: eventData.force_all },
        });
      }
      totalRemaining += newRemaining;
    }

    return { enriched: totalEnriched, remaining: totalRemaining };
  },
);

// ----------------------------------------------------------------------------
// 5b. enrich-single
// ----------------------------------------------------------------------------

export const enrichSingle = inngest.createFunction(
  {
    id: "demographics-enrich-single",
    retries: 2,
    concurrency: [{ limit: 10, key: "event.data.workspace_id" }],
    triggers: [{ event: "demographics/enrich-single" }],
  },
  async ({ event, step }) => {
    const { workspace_id, customer_id } = event.data as {
      workspace_id: string;
      customer_id: string;
    };

    const customer = await step.run("fetch-customer", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("customers")
        .select("id, workspace_id, first_name, default_address")
        .eq("id", customer_id)
        .eq("workspace_id", workspace_id)
        .single();
      return data;
    });

    if (!customer) return { enriched: false, reason: "customer-not-found" };

    // Inngest serializes step.run return values, so Maps become plain
    // objects. Return entries and rehydrate outside the step.
    const nameEntries = await step.run("infer-name", async () => {
      const map = await inferNamesBatch([customer.first_name || ""]);
      return Array.from(map.entries());
    });
    const nameMap = new Map(nameEntries);

    const apiKey = await step.run("census-key", async () =>
      (await getCensusApiKey(workspace_id)) || null,
    );

    await step.run("enrich", async () => {
      await enrichOne(customer as CustomerShape, nameMap, apiKey || undefined);
    });

    return { enriched: true };
  },
);

// =============================================================================
// Snapshot builder — pre-computes demographics summaries for instant page loads
// =============================================================================

const CONFIDENCE_FLOOR = 0.65;
const GENDERS = ["female", "male", "unknown"] as const;
const AGE_RANGES = ["under_25", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
const INCOME_BRACKETS = ["under_40k", "40-60k", "60-80k", "80-100k", "100-125k", "125-150k", "150k+"] as const;
const URBAN_TYPES = ["urban", "suburban", "rural"] as const;
const BUYER_TYPES_LIST = ["committed_subscriber", "new_subscriber", "lapsed_subscriber", "value_buyer", "cautious_buyer", "one_time_buyer"] as const;

function emptyDist<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

function modeOf<K extends string>(dist: Record<K, number>): K | null {
  let best: K | null = null;
  let bestCount = 0;
  for (const key of Object.keys(dist) as K[]) {
    if (dist[key] > bestCount) { bestCount = dist[key]; best = key; }
  }
  return bestCount > 0 ? best : null;
}

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

function computeSummary(rows: DemoRow[], totalCustomers: number) {
  const gender_distribution = emptyDist(GENDERS);
  const age_distribution = emptyDist(AGE_RANGES);
  const income_distribution = emptyDist(INCOME_BRACKETS);
  const urban_distribution = emptyDist(URBAN_TYPES);
  const buyer_type_distribution = emptyDist(BUYER_TYPES_LIST);
  const priorityCounts = new Map<string, number>();

  for (const r of rows) {
    if (r.inferred_gender && (r.inferred_gender_conf ?? 0) >= CONFIDENCE_FLOOR && GENDERS.includes(r.inferred_gender as typeof GENDERS[number])) {
      gender_distribution[r.inferred_gender as typeof GENDERS[number]]++;
    }
    if (r.inferred_age_range && (r.inferred_age_conf ?? 0) >= CONFIDENCE_FLOOR && AGE_RANGES.includes(r.inferred_age_range as typeof AGE_RANGES[number])) {
      age_distribution[r.inferred_age_range as typeof AGE_RANGES[number]]++;
    }
    if (r.zip_income_bracket && INCOME_BRACKETS.includes(r.zip_income_bracket as typeof INCOME_BRACKETS[number])) {
      income_distribution[r.zip_income_bracket as typeof INCOME_BRACKETS[number]]++;
    }
    if (r.zip_urban_classification && URBAN_TYPES.includes(r.zip_urban_classification as typeof URBAN_TYPES[number])) {
      urban_distribution[r.zip_urban_classification as typeof URBAN_TYPES[number]]++;
    }
    if (r.buyer_type && BUYER_TYPES_LIST.includes(r.buyer_type as typeof BUYER_TYPES_LIST[number])) {
      buyer_type_distribution[r.buyer_type as typeof BUYER_TYPES_LIST[number]]++;
    }
    for (const p of r.health_priorities || []) {
      if (typeof p === "string") priorityCounts.set(p, (priorityCounts.get(p) || 0) + 1);
    }
  }

  const top_health_priorities = Array.from(priorityCounts.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([priority, count]) => ({ priority, count }));

  // Suggested target customer
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
    gender_distribution,
    age_distribution,
    income_distribution,
    urban_distribution,
    buyer_type_distribution,
    top_health_priorities,
    suggested_target_customer: rows.length > 0 ? parts.join(", ") : null,
  };
}

export const demographicsSnapshotBuilder = inngest.createFunction(
  {
    id: "demographics-snapshot-builder",
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 8 * * 0" },  // Weekly — Sundays at 3 AM Central (8 UTC)
      { event: "demographics/rebuild-snapshots" },
    ],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaces = await step.run("get-workspaces", async () => {
      const { data } = await admin.from("workspaces").select("id");
      return data || [];
    });

    for (const ws of workspaces) {
      await step.run(`snapshot-all-${ws.id.slice(0, 8)}`, async () => {
        // All customers snapshot
        const { data: allRows } = await admin.from("customer_demographics")
          .select("customer_id, inferred_gender, inferred_gender_conf, inferred_age_range, inferred_age_conf, zip_income_bracket, zip_urban_classification, buyer_type, health_priorities")
          .eq("workspace_id", ws.id);

        const { count: totalCustomers } = await admin.from("customers")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", ws.id)
          .gt("total_orders", 0);

        const summary = computeSummary((allRows || []) as DemoRow[], totalCustomers || 0);

        await admin.from("demographics_snapshots").upsert({
          workspace_id: ws.id,
          product_id: null,
          ...summary,
          computed_at: new Date().toISOString(),
        }, { onConflict: "workspace_id" });
      });

      // Per-product snapshots
      await step.run(`snapshot-products-${ws.id.slice(0, 8)}`, async () => {
        const { data: products } = await admin.from("products")
          .select("id, variants")
          .eq("workspace_id", ws.id)
          .eq("status", "active");

        for (const product of products || []) {
          const variants = (product.variants || []) as { id?: string; sku?: string }[];
          const variantIds = new Set(variants.map(v => String(v.id)).filter(Boolean));
          const skus = new Set(variants.map(v => v.sku).filter(Boolean) as string[]);
          if (variantIds.size === 0 && skus.size === 0) continue;

          // Find customer IDs who ordered this product
          const custIds = new Set<string>();
          let offset = 0;
          while (true) {
            const { data: orders } = await admin.from("orders")
              .select("customer_id, line_items")
              .eq("workspace_id", ws.id)
              .range(offset, offset + 999);
            if (!orders?.length) break;
            for (const o of orders) {
              const items = (o.line_items || []) as { variant_id?: string; sku?: string }[];
              if (items.some(i =>
                (i.variant_id && variantIds.has(String(i.variant_id))) ||
                (i.sku && skus.has(i.sku))
              )) {
                custIds.add(o.customer_id);
              }
            }
            if (orders.length < 1000) break;
            offset += 1000;
          }

          if (custIds.size === 0) {
            await admin.from("demographics_snapshots").upsert({
              workspace_id: ws.id,
              product_id: product.id,
              total_customers: 0, enriched_count: 0,
              gender_distribution: {}, age_distribution: {}, income_distribution: {},
              urban_distribution: {}, buyer_type_distribution: {},
              top_health_priorities: [], suggested_target_customer: null,
              computed_at: new Date().toISOString(),
            }, { onConflict: "workspace_id,product_id" });
            continue;
          }

          // Get demographics for these customers
          const allRows: DemoRow[] = [];
          const custIdArr = [...custIds];
          for (let i = 0; i < custIdArr.length; i += 100) {
            const { data } = await admin.from("customer_demographics")
              .select("customer_id, inferred_gender, inferred_gender_conf, inferred_age_range, inferred_age_conf, zip_income_bracket, zip_urban_classification, buyer_type, health_priorities")
              .eq("workspace_id", ws.id)
              .in("customer_id", custIdArr.slice(i, i + 100));
            if (data) allRows.push(...(data as DemoRow[]));
          }

          const summary = computeSummary(allRows, custIds.size);
          await admin.from("demographics_snapshots").upsert({
            workspace_id: ws.id,
            product_id: product.id,
            ...summary,
            computed_at: new Date().toISOString(),
          }, { onConflict: "workspace_id,product_id" });
        }
      });
    }

    return { workspaces: workspaces.length };
  },
);
