import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const [totalRes, enrichedRes, latestRes, zipRes] = await Promise.all([
    admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    admin
      .from("customer_demographics")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    admin
      .from("customer_demographics")
      .select("enriched_at, enrichment_version")
      .eq("workspace_id", workspaceId)
      .order("enriched_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("zip_code_demographics").select("zip_code", { count: "exact", head: true }),
  ]);

  const total = totalRes.count || 0;
  const enriched = enrichedRes.count || 0;

  return NextResponse.json({
    total_customers: total,
    enriched,
    pending: Math.max(0, total - enriched),
    last_enriched_at: latestRes.data?.enriched_at ?? null,
    enrichment_version: latestRes.data?.enrichment_version ?? null,
    zip_codes_cached: zipRes.count || 0,
  });
}
