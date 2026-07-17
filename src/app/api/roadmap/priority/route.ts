/**
 * POST /api/roadmap/priority — set/clear a spec's **Priority:** critical flag or **Deferred:**
 * parked flag by writing the `spec_card_state` DB mirror. Owner-gated (mirrors /api/roadmap/status).
 *
 * spec-status-db-driven Phase 2: this used to PUT the markdown to `main` for every flag toggle (one of
 * the six git-committing status writers). The flags now live on the DB mirror directly
 * (`flags.critical` / `flags.deferred`) — instant write, zero deploys. The unified 3-state control
 * still accepts critical | deferred | planned (mutually exclusive); the legacy `{ critical: boolean }`
 * shape stays for the back-compat caller.
 *
 * Body: { slug, state: "critical" | "deferred" | "planned" } or { slug, critical: boolean }.
 * See docs/brain/specs/director-executable-plans-and-priority-board-pip.md (Phase 1).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { markSpecCardCritical, markSpecCardDeferred } from "@/lib/spec-card-state";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; critical?: unknown; state?: unknown };
  const { slug, critical } = body;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }
  const state = body.state === "critical" || body.state === "deferred" || body.state === "planned" ? body.state : null;
  if (!state && typeof critical !== "boolean") {
    return NextResponse.json({ error: "bad critical/state" }, { status: 400 });
  }

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can change roadmap priority" }, { status: 403 });
  }

  const actor = `owner:${user.id}`;
  if (state) {
    // Mutually exclusive: setting one clears the other; planned clears both.
    await markSpecCardCritical(workspaceId, slug, state === "critical", { actor, reason: `priority → ${state}` });
    await markSpecCardDeferred(workspaceId, slug, state === "deferred", { actor, reason: `priority → ${state}` });
    return NextResponse.json({ ok: true, state });
  }
  await markSpecCardCritical(workspaceId, slug, critical as boolean, { actor, reason: `critical → ${critical}` });
  return NextResponse.json({ ok: true, critical });
}
