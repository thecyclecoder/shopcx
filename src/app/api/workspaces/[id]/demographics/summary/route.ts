import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const CONFIDENCE_FLOOR = 0.65;

const GENDERS = ["female", "male", "unknown"] as const;
const AGE_RANGES = ["under_25", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
const INCOME_BRACKETS = [
  "under_40k",
  "40-60k",
  "60-80k",
  "80-100k",
  "100-125k",
  "125-150k",
  "150k+",
] as const;
const URBAN = ["urban", "suburban", "rural"] as const;
const BUYER_TYPES = [
  "committed_subscriber",
  "new_subscriber",
  "lapsed_subscriber",
  "value_buyer",
  "cautious_buyer",
  "one_time_buyer",
] as const;

function emptyDist<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

function mode<K extends string>(dist: Record<K, number>): K | null {
  let best: K | null = null;
  let bestCount = 0;
  for (const key of Object.keys(dist) as K[]) {
    if (dist[key] > bestCount) {
      bestCount = dist[key];
      best = key;
    }
  }
  return bestCount > 0 ? best : null;
}

function genderWord(g: string): string {
  if (g === "female") return "Women";
  if (g === "male") return "Men";
  return "Adults";
}

function incomeWord(b: string): string {
  const map: Record<string, string> = {
    "under_40k": "under $40K",
    "40-60k": "$40-60K",
    "60-80k": "$60-80K",
    "80-100k": "$80-100K",
    "100-125k": "$100-125K",
    "125-150k": "$125-150K",
    "150k+": "$150K+",
  };
  return map[b] || b;
}

function urbanWord(u: string): string {
  const map: Record<string, string> = {
    urban: "urban",
    suburban: "suburban",
    rural: "rural",
  };
  return map[u] || u;
}

function buyerWord(b: string): string {
  const map: Record<string, string> = {
    committed_subscriber: "committed subscribers",
    new_subscriber: "new subscribers",
    lapsed_subscriber: "lapsed subscribers",
    value_buyer: "value-oriented buyers",
    cautious_buyer: "cautious buyers",
    one_time_buyer: "one-time buyers",
  };
  return map[b] || b;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const productId = url.searchParams.get("product_id");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // If filtering by product, find customer IDs who ordered that product
  let customerIdFilter: string[] | null = null;
  if (productId) {
    const { data: product } = await admin.from("products")
      .select("variants").eq("id", productId).single();
    if (product?.variants) {
      // Get all variant IDs and SKUs for this product
      const variants = product.variants as { id?: string; sku?: string }[];
      const variantIds = new Set(variants.map(v => String(v.id)).filter(Boolean));
      const skus = new Set(variants.map(v => v.sku).filter(Boolean) as string[]);

      // Find orders containing any of these variants
      const allCustIds = new Set<string>();
      let offset = 0;
      while (true) {
        const { data: orders } = await admin.from("orders")
          .select("customer_id, line_items")
          .eq("workspace_id", workspaceId)
          .range(offset, offset + 999);
        if (!orders?.length) break;
        for (const o of orders) {
          const items = (o.line_items || []) as { variant_id?: string; sku?: string }[];
          if (items.some(i =>
            (i.variant_id && variantIds.has(String(i.variant_id))) ||
            (i.sku && skus.has(i.sku))
          )) {
            allCustIds.add(o.customer_id);
          }
        }
        if (orders.length < 1000) break;
        offset += 1000;
      }
      customerIdFilter = [...allCustIds];
    }
  }

  const [totalRes, demographicsRes] = await Promise.all([
    admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    (async () => {
      if (customerIdFilter !== null && customerIdFilter.length === 0) {
        return { data: [] };
      }
      let query = admin
        .from("customer_demographics")
        .select(
          "customer_id, inferred_gender, inferred_gender_conf, inferred_age_range, inferred_age_conf, zip_income_bracket, zip_urban_classification, buyer_type, health_priorities",
        )
        .eq("workspace_id", workspaceId);
      if (customerIdFilter) {
        // Batch in groups of 100 to avoid URL length issues
        const allRows: typeof query extends Promise<{ data: infer T }> ? NonNullable<T> : never[] = [];
        for (let i = 0; i < customerIdFilter.length; i += 100) {
          const { data } = await admin
            .from("customer_demographics")
            .select(
              "customer_id, inferred_gender, inferred_gender_conf, inferred_age_range, inferred_age_conf, zip_income_bracket, zip_urban_classification, buyer_type, health_priorities",
            )
            .eq("workspace_id", workspaceId)
            .in("customer_id", customerIdFilter.slice(i, i + 100));
          if (data) (allRows as unknown[]).push(...data);
        }
        return { data: allRows };
      }
      return query;
    })(),
  ]);

  const total_customers = totalRes.count || 0;
  const rows = demographicsRes.data || [];
  const enriched_count = rows.length;

  const gender_distribution = emptyDist(GENDERS);
  const age_distribution = emptyDist(AGE_RANGES);
  const income_distribution = emptyDist(INCOME_BRACKETS);
  const urban_distribution = emptyDist(URBAN);
  const buyer_type_distribution = emptyDist(BUYER_TYPES);
  const priorityCounts = new Map<string, number>();

  // Only count high-confidence values in distributions
  for (const r of rows) {
    if (
      r.inferred_gender &&
      (r.inferred_gender_conf ?? 0) >= CONFIDENCE_FLOOR &&
      GENDERS.includes(r.inferred_gender as (typeof GENDERS)[number])
    ) {
      gender_distribution[r.inferred_gender as (typeof GENDERS)[number]]++;
    }
    if (
      r.inferred_age_range &&
      (r.inferred_age_conf ?? 0) >= CONFIDENCE_FLOOR &&
      AGE_RANGES.includes(r.inferred_age_range as (typeof AGE_RANGES)[number])
    ) {
      age_distribution[r.inferred_age_range as (typeof AGE_RANGES)[number]]++;
    }
    if (r.zip_income_bracket && INCOME_BRACKETS.includes(r.zip_income_bracket as (typeof INCOME_BRACKETS)[number])) {
      income_distribution[r.zip_income_bracket as (typeof INCOME_BRACKETS)[number]]++;
    }
    if (r.zip_urban_classification && URBAN.includes(r.zip_urban_classification as (typeof URBAN)[number])) {
      urban_distribution[r.zip_urban_classification as (typeof URBAN)[number]]++;
    }
    if (r.buyer_type && BUYER_TYPES.includes(r.buyer_type as (typeof BUYER_TYPES)[number])) {
      buyer_type_distribution[r.buyer_type as (typeof BUYER_TYPES)[number]]++;
    }
    for (const p of r.health_priorities || []) {
      if (typeof p !== "string") continue;
      priorityCounts.set(p, (priorityCounts.get(p) || 0) + 1);
    }
  }

  const top_health_priorities = Array.from(priorityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([priority, count]) => ({ priority, count }));

  // Suggested target customer — mode of each dimension
  const parts: string[] = [];
  const gMode = mode(gender_distribution);
  const aMode = mode(age_distribution);
  const iMode = mode(income_distribution);
  const uMode = mode(urban_distribution);
  const bMode = mode(buyer_type_distribution);

  if (gMode && aMode) {
    parts.push(`${genderWord(gMode)} ${aMode.replace("_", " ")}`);
  } else if (gMode) {
    parts.push(genderWord(gMode));
  } else if (aMode) {
    parts.push(`Adults ${aMode.replace("_", " ")}`);
  }

  if (uMode) parts.push(`${urbanWord(uMode)} households`);
  if (iMode) parts.push(`${incomeWord(iMode)} household income`);
  if (bMode) parts.push(buyerWord(bMode));

  const topPriorities = top_health_priorities.slice(0, 2).map((p) => p.priority.replace(/_/g, " "));
  if (topPriorities.length > 0) {
    parts.push(`focused on ${topPriorities.join(" and ")}`);
  }

  const suggested_target_customer =
    enriched_count === 0 ? null : parts.filter(Boolean).join(", ");

  return NextResponse.json({
    total_customers,
    enriched_count,
    gender_distribution,
    age_distribution,
    income_distribution,
    urban_distribution,
    buyer_type_distribution,
    top_health_priorities,
    suggested_target_customer,
  });
}
