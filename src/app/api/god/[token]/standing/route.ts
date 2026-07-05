/**
 * POST /api/god/[token]/standing — the cockpit twin of /api/god-mode/standing.
 *
 * CEO-grade god-mode (docs/brain/lifecycles/god-mode.md). Token IS the auth (same
 * convention as the other /god/[token] routes). Body: { action:'revoke', category }.
 * Revokes the workspace's "don't ask again" standing approval for that decision
 * category. 404 on unknown/disarmed token, 410 on expired.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveCockpitToken, revokeStanding, bumpActivity } from "@/lib/god-mode";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: string; category?: string };
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (body.action !== "revoke" || !category) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const res = await resolveCockpitToken(admin, token);
  if (res.kind === "not_found" || res.kind === "disarmed") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (res.kind === "expired") return NextResponse.json({ error: "expired" }, { status: 410 });

  await revokeStanding(admin, { workspaceId: res.session.workspace_id, category });
  await bumpActivity(admin, res.session.id);
  return NextResponse.json({ ok: true });
}
