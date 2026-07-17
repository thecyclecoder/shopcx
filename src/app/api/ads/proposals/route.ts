import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateAvatarProposals } from "@/lib/ad-avatar-proposals";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId)
    return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const productId = url.searchParams.get("productId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  let query = auth.admin
    .from("ad_avatar_proposals")
    .select(
      "id, product_id, archetype_brief, demographic_basis, status, confirmed_avatar_id, created_at, products(title)",
    )
    .eq("workspace_id", workspaceId as string)
    .eq("status", "proposed")
    .order("created_at", { ascending: false });

  if (productId) query = query.eq("product_id", productId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

export async function POST(req: Request) {
  const body = await req.json();
  const workspaceId: string | null = body.workspaceId ?? null;
  const productId: string | undefined = body.productId;
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  // Confirm the product belongs to this workspace before spending an Opus call.
  const { data: product } = await auth.admin
    .from("products")
    .select("id, workspace_id")
    .eq("id", productId)
    .single();
  if (!product || product.workspace_id !== workspaceId)
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  // forceRefresh recomputes the joint archetypes from raw demographics; default
  // reuses the cached archetypes on demographics_snapshots (cheap).
  const result = await generateAvatarProposals(productId, 5, body.forceRefresh === true);
  return NextResponse.json({ ok: result.ok, count: result.proposals.length, reason: result.reason });
}
