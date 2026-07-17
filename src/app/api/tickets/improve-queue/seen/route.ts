/**
 * POST /api/tickets/improve-queue/seen — mark a ticket's Improve session read (improve-queue-mark-read).
 *
 * Sets ticket_improve_chats.seen_at = updated_at for the ticket's session, which clears it from the
 * "Waiting on you" (unread) queue + decrements the nav badge until the next box turn (which bumps
 * updated_at, making updated_at > seen_at again → it re-surfaces). Two callers:
 *   1. the queue row's "Mark read" button (an FYI reply you don't need to open), and
 *   2. the ticket Improve tab on mount (auto-mark-on-open — clicking through clears it).
 *
 * Reading ≠ approving: a still-parked pending_plan stays separately actionable (a distinct
 * "needs approval" chip persists even once read). Gated to owner / admin / cs_manager.
 * See docs/brain/specs/improve-queue-mark-read.md.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];

export async function POST(request: Request) {
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
  if (!member || !ALLOWED_ROLES.includes(member.role)) {
    return NextResponse.json({ error: "Owner, admin, or CS manager role required" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { ticket_id?: string };
  const ticketId = (body.ticket_id || "").trim();
  if (!ticketId) return NextResponse.json({ error: "ticket_id required" }, { status: 400 });

  // Mark read = catch seen_at up to the session's current updated_at. We read updated_at first rather
  // than `set seen_at = updated_at` in SQL so a concurrent box turn that bumps updated_at after this
  // read stays unread (its new content hasn't been seen) — the conservative, never-hide-new-replies side.
  const { data: session, error: loadErr } = await admin
    .from("ticket_improve_chats")
    .select("id, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: "No Improve session for this ticket" }, { status: 404 });

  // Don't touch updated_at — marking read is not a session edit, and bumping it would re-surface itself.
  const { error: updateErr } = await admin
    .from("ticket_improve_chats")
    .update({ seen_at: session.updated_at })
    .eq("id", session.id)
    .eq("workspace_id", workspaceId);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, seen_at: session.updated_at });
}
