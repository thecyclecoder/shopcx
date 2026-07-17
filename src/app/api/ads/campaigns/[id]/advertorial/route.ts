import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateAdvertorialPagesForCampaign } from "@/lib/advertorial-pages";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

/**
 * Generate the ad-matched lander(s) for a campaign (advertorial + before/after
 * when transformation media exists). Persists advertorial_pages rows keyed by
 * (product_id, slug). See docs/brain/specs/advertorial-landers.md.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const workspaceId: string | null = body.workspaceId ?? null;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data: campaign } = await auth.admin
    .from("ad_campaigns")
    .select("id")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!campaign) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await generateAdvertorialPagesForCampaign(workspaceId as string, id);
  if (!result.ok) return NextResponse.json({ error: result.reason || "generation_failed" }, { status: 400 });
  return NextResponse.json({ ok: true, landers: result.landers });
}

/** List the generated landers for this campaign's product. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const { data: campaign } = await auth.admin
    .from("ad_campaigns")
    .select("product_id")
    .eq("id", id)
    .eq("workspace_id", workspaceId as string)
    .single();
  if (!campaign?.product_id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: pages } = await auth.admin
    .from("advertorial_pages")
    .select("slug, variant, headline, hero_kind, status, updated_at")
    .eq("workspace_id", workspaceId as string)
    .eq("product_id", campaign.product_id)
    .order("updated_at", { ascending: false });

  return NextResponse.json({ landers: pages || [] });
}
