import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function authorize(workspaceId: string | null) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!workspaceId) return { error: NextResponse.json({ error: "workspaceId required" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user, admin };
}

/** Public URL for an internally-created lander, on the in-house storefront domain. */
function landerUrl(domain: string | null, slug: string | null, handle: string, variant: string, angleSlug: string): string | null {
  if (!handle) return null;
  const qs = `?variant=${variant}&angle=${encodeURIComponent(angleSlug)}`;
  if (domain) return `https://${domain}/${handle}${qs}`;
  if (slug) return `https://shopcx.ai/store/${slug}/${handle}${qs}`;
  return null;
}

export async function GET(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const [{ data: ws }, { data: pages }] = await Promise.all([
    auth.admin.from("workspaces").select("storefront_domain, storefront_slug").eq("id", workspaceId as string).maybeSingle(),
    auth.admin
      .from("advertorial_pages")
      .select("id, slug, variant, headline, hero_kind, status, updated_at, product_id, products(title, handle)")
      .eq("workspace_id", workspaceId as string)
      .order("updated_at", { ascending: false }),
  ]);

  const landers = (pages || []).map((p) => {
    const product = (p as { products?: { title?: string; handle?: string } | null }).products || null;
    const handle = product?.handle || "";
    return {
      id: p.id,
      variant: p.variant,
      slug: p.slug,
      headline: p.headline,
      hero_kind: p.hero_kind,
      status: p.status,
      updated_at: p.updated_at,
      product_title: product?.title || null,
      url: landerUrl(ws?.storefront_domain || null, ws?.storefront_slug || null, handle, p.variant, p.slug),
    };
  });

  return NextResponse.json({ landers });
}
