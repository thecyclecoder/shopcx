// Research › Ads — the product dropdown source. Returns the workspace's ADVERTISED (hero) products only
// ({ id, title }), so the Research › Ads page filters competitor ads to one of the ~6 hero products. Owner-
// gated (mirrors the creative-finder route). Reads is_advertised via the advertised-products SDK.
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdvertisedProductIds } from "@/lib/advertised-products";

export async function GET(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });

  // Owner/admin gate — same shape as /api/ads/competitors.
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (member as { role?: string } | null)?.role;
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const ids = await listAdvertisedProductIds(admin, workspaceId);
  if (ids.length === 0) return NextResponse.json([]);
  const { data: products } = await admin
    .from("products")
    .select("id, title")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  const rows = ((products ?? []) as { id: string; title: string | null }[])
    .map((p) => ({ id: p.id, title: p.title }))
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  return NextResponse.json(rows);
}
