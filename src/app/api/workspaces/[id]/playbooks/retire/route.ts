/**
 * POST /api/workspaces/[id]/playbooks/retire
 *
 * Retire an active playbook — flips `playbooks.is_active=false` and writes a
 * `director_activity` row of `action_kind='playbook_retired'` for the CS
 * director's audit trail (playbook-compiler-loop § Phase 2 — existing-
 * playbook audit surface). The Retire button on
 * `/dashboard/settings/playbooks/audit` is the sole caller today.
 *
 * Guard-before-mutation invariant (per the coaching notes in CLAUDE.md):
 *   1. Enumerate the playbook by (id, workspace_id) — never by id alone.
 *   2. The UPDATE is a compare-and-set: `.eq('workspace_id', …).eq('id', …)
 *      .eq('is_active', true).select('id')` — an already-retired playbook,
 *      a wrong-workspace playbook, or a stale row can't be reflipped.
 *   3. Only WHEN THE UPDATE ACTUALLY FLIPPED A ROW do we record the
 *      director_activity audit — the audit reflects the real state
 *      transition, not a proxy read.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";

interface RetireBody {
  playbook_id?: string;
  reason?: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as RetireBody;
  const playbookId = body?.playbook_id;
  if (!playbookId) return NextResponse.json({ error: "playbook_id required" }, { status: 400 });

  const admin = createAdminClient();

  // Explicit workspace-membership authz gate — a retire is destructive (flips
  // `is_active=false` on a customer-facing playbook + writes an audit row), so
  // the endpoint MUST reject a caller who is authenticated but not an
  // owner/admin of THIS workspace. Mirrors the pattern in
  // src/app/api/workspaces/[id]/journeys/route.ts POST. Without this guard an
  // authenticated cross-workspace caller could retire another tenant's
  // playbooks (authz_rls regression class).
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["owner", "admin"].includes(String(member.role))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Compare-and-set: only flip playbooks that are currently active in THIS
  // workspace. `.select('id')` lets us assert one-row-transitioned before we
  // emit the audit row — an already-retired row silently returns [] and we
  // bail without writing a duplicate audit entry.
  const { data: flipped } = await admin
    .from("playbooks")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", playbookId)
    .eq("is_active", true)
    .select("id, name");

  if (!flipped || flipped.length === 0) {
    return NextResponse.json({ ok: true, already_retired: true });
  }

  const pb = flipped[0] as { id: string; name: string };

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "cs",
    actionKind: "playbook_retired",
    specSlug: "playbook-compiler-loop-mine-resolution-records-and-audit-existing-playbooks",
    reason: body?.reason || `Playbook '${pb.name}' retired from the audit surface.`,
    metadata: {
      playbook_id: pb.id,
      playbook_name: pb.name,
      retired_by: user.id,
      source: "audit_ui",
    },
  });

  return NextResponse.json({ ok: true, retired: pb.id });
}
