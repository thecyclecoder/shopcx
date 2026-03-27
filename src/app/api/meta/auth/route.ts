import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildMetaAuthUrl } from "@/lib/meta";
import { randomBytes } from "crypto";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { workspace_id } = await request.json();
  if (!workspace_id) return NextResponse.json({ error: "workspace_id required" }, { status: 400 });

  const admin = createAdminClient();

  // Verify role
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const appId = process.env.META_APP_ID;
  if (!appId) {
    return NextResponse.json({ error: "META_APP_ID not configured" }, { status: 500 });
  }

  const state = randomBytes(16).toString("hex");
  const statePayload = `${workspace_id}:${state}`;

  // Store state for callback verification
  await admin
    .from("workspaces")
    .update({ meta_oauth_state: state })
    .eq("id", workspace_id);

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const redirectUri = `${siteUrl}/api/meta/callback`;

  const url = buildMetaAuthUrl({
    appId,
    redirectUri,
    state: statePayload,
  });

  return NextResponse.json({ url });
}
