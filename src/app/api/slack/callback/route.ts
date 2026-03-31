import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, saveSlackConnection, autoMapTeamMembers } from "@/lib/slack";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/settings/integrations?slack=error&reason=${error}`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/settings/integrations?slack=error&reason=missing_params`);
  }

  let workspaceId: string;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString());
    workspaceId = parsed.workspaceId;
  } catch {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/settings/integrations?slack=error&reason=invalid_state`);
  }

  const result = await exchangeCodeForToken(code);
  if (!result.ok || !result.access_token) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/settings/integrations?slack=error&reason=${result.error || "token_exchange_failed"}`);
  }

  await saveSlackConnection(
    workspaceId,
    result.access_token,
    result.team?.id || "",
    result.team?.name || "",
  );

  // Auto-map team members (non-blocking)
  autoMapTeamMembers(workspaceId).catch((e) => console.error("[Slack] auto-map error:", e));

  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_SITE_URL}/dashboard/settings/integrations?slack=connected`);
}
