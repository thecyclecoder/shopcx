import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdsForCreativePanel } from "@/lib/ads/ads-read-sdk";

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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: productId } = await params;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const [active, latest] = await Promise.all([
    listAdsForCreativePanel(auth.admin, {
      workspaceId: workspaceId as string,
      productId,
      statuses: ["active"],
      limit: 50,
    }),
    listAdsForCreativePanel(auth.admin, {
      workspaceId: workspaceId as string,
      productId,
      statuses: ["active", "ready"],
      limit: 6,
    }),
  ]);

  return NextResponse.json({ activeTests: active, latestPreviews: latest });
}
