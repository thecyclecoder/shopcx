import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken, listAdAccounts, listCampaigns, listAdSets, listPages } from "@/lib/meta-ads";

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
 * Meta selectors for the publish flow:
 *   ?resource=accounts | pages | campaigns&accountId= | adsets&accountId=&campaignId=
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const auth = await authorize(workspaceId);
  if (auth.error) return auth.error;

  const token = await getMetaUserToken(workspaceId as string);
  if (!token) return NextResponse.json({ error: "meta_not_connected" }, { status: 400 });

  const resource = url.searchParams.get("resource") || "accounts";
  const accountId = url.searchParams.get("accountId") || "";
  const campaignId = url.searchParams.get("campaignId") || "";

  try {
    switch (resource) {
      case "accounts": return NextResponse.json({ accounts: await listAdAccounts(token) });
      case "pages": return NextResponse.json({ pages: await listPages(token) });
      case "campaigns":
        if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });
        return NextResponse.json({ campaigns: await listCampaigns(token, accountId) });
      case "adsets":
        if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });
        return NextResponse.json({ adsets: await listAdSets(token, accountId, campaignId || undefined) });
      default:
        return NextResponse.json({ error: "unknown_resource" }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 502 });
  }
}
