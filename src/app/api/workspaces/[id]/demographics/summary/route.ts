import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET: Demographics summary — reads from pre-computed snapshots (instant).
 * Snapshots are rebuilt nightly by demographics-snapshot-builder cron.
 * Accepts optional ?product_id= to get per-product demographics.
 */
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

  let query = admin
    .from("demographics_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId);

  if (productId) {
    query = query.eq("product_id", productId);
  } else {
    query = query.is("product_id", null);
  }

  const { data: snapshot } = await query.maybeSingle();

  if (!snapshot) {
    // No snapshot yet — return empty with a hint to run the builder
    return NextResponse.json({
      total_customers: 0,
      enriched_count: 0,
      gender_distribution: {},
      age_distribution: {},
      income_distribution: {},
      urban_distribution: {},
      buyer_type_distribution: {},
      top_health_priorities: [],
      suggested_target_customer: null,
      computed_at: null,
      needs_rebuild: true,
    });
  }

  return NextResponse.json({
    total_customers: snapshot.total_customers,
    enriched_count: snapshot.enriched_count,
    gender_distribution: snapshot.gender_distribution,
    age_distribution: snapshot.age_distribution,
    income_distribution: snapshot.income_distribution,
    urban_distribution: snapshot.urban_distribution,
    buyer_type_distribution: snapshot.buyer_type_distribution,
    top_health_priorities: snapshot.top_health_priorities,
    suggested_target_customer: snapshot.suggested_target_customer,
    computed_at: snapshot.computed_at,
  });
}
