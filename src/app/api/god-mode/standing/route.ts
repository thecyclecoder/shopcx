/**
 * POST /api/god-mode/standing — revoke a "don't ask again" standing approval.
 *
 * CEO-grade god-mode (docs/brain/lifecycles/god-mode.md). Owner-gated. Body:
 * { action: 'revoke', category }. Removes the workspace's standing grant for that
 * decision category so god-mode asks about it again. The list of current grants is
 * returned by GET /api/god-mode/session; this route only mutates.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokeStanding } from "@/lib/god-mode";

async function requireOwner() {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can use god mode" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { workspaceId, admin } = auth;

  const body = (await request.json().catch(() => ({}))) as { action?: string; category?: string };
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (body.action !== "revoke" || !category) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  await revokeStanding(admin, { workspaceId, category });
  return NextResponse.json({ ok: true });
}
