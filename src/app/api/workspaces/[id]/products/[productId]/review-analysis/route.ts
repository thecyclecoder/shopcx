import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("product_review_analysis")
    .select(
      "top_benefits, before_after_pain_points, skeptic_conversions, surprise_benefits, most_powerful_phrases, reviews_analyzed_count, analyzed_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .maybeSingle();

  return NextResponse.json({ analysis: data || null });
}
