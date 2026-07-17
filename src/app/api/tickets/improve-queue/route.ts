/**
 * /api/tickets/improve-queue — the Improve Queue surface (improve-queue spec).
 *
 * A workspace-scoped, read-only view over public.ticket_improve_chats joined to tickets (subject)
 * + customers (name), so the founder / CX manager can fire off several box Improve turns, walk away,
 * and glance at which ones the box has answered — then deep-link straight to the ticket's Improve tab.
 * No schema change: the data already lives in ticket_improve_chats.
 *
 * GET → { items: ImproveQueueItem[], counts: { waiting, in_progress } }, ordered updated_at desc.
 *
 * `queue_state` is derived from turn_status (+ last message role for the "answered" signal):
 *   awaiting_approval → 'needs_approval'   (a plan is parked — Approve/Decline)   ┐
 *   error             → 'error'            (last_error set; sending again retries) ├─ "waiting" states
 *   idle + assistant-last message → 'answered' (the box replied, you haven't replied since) ┘
 *   thinking          → 'thinking'         (a turn is in flight)                  — "In progress"
 *   idle + no assistant-last → 'idle'      (nothing waiting — not surfaced)
 *
 * `unread` (improve-queue-mark-read) splits the waiting states by read-state: a waiting session is
 * unread when the box has changed it since you last looked — seen_at IS NULL OR updated_at > seen_at.
 * Marking read (POST …/seen) sets seen_at = updated_at, so a later box turn (which bumps updated_at)
 * re-surfaces it. counts.waiting = the UNREAD waiting count (the nav badge). Read-but-still-waiting
 * sessions are still returned (the page shows them greyed under "Earlier") — nothing is truly lost,
 * and a still-parked pending_plan keeps its "needs approval" chip even once read (reading ≠ approving).
 *
 * Gated to owner / admin / cs_manager (the same roles that can drive Improve — box-ticket-improve P4).
 * See docs/brain/specs/improve-queue.md + docs/brain/specs/improve-queue-mark-read.md.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import type { ChatMsg, TurnStatus } from "@/lib/ticket-improve-chats";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];

export type ImproveQueueState = "answered" | "needs_approval" | "error" | "thinking" | "idle";

export interface ImproveQueueItem {
  ticket_id: string;
  subject: string | null;
  customer_name: string | null;
  turn_status: TurnStatus;
  queue_state: ImproveQueueState;
  last_error: string | null;
  updated_at: string;
  // improve-queue-mark-read: false once the founder/CX manager has marked this session read
  // (seen_at >= updated_at). A later box turn bumps updated_at, flipping it back to unread.
  unread: boolean;
}

const WAITING_STATES: ImproveQueueState[] = ["answered", "needs_approval", "error"];

function lastRole(messages: unknown): "user" | "assistant" | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as ChatMsg | undefined;
  return last?.role === "assistant" || last?.role === "user" ? last.role : null;
}

function deriveState(turnStatus: TurnStatus, messages: unknown): ImproveQueueState {
  switch (turnStatus) {
    case "awaiting_approval":
      return "needs_approval";
    case "error":
      return "error";
    case "thinking":
      return "thinking";
    case "idle":
    default:
      return lastRole(messages) === "assistant" ? "answered" : "idle";
  }
}

function customerName(customer: { first_name?: string | null; last_name?: string | null; email?: string | null } | null): string | null {
  if (!customer) return null;
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim();
  return name || customer.email || null;
}

export async function GET() {
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

  // Active sessions only — a resolved session means the closeout already ran (ticket closed),
  // so it no longer belongs in a "waiting on you" queue.
  const { data, error } = await admin
    .from("ticket_improve_chats")
    .select("ticket_id, turn_status, messages, last_error, updated_at, seen_at, tickets(subject, customers(first_name, last_name, email))")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const items: ImproveQueueItem[] = (data ?? [])
    .map((row) => {
      const ticket = (row.tickets ?? null) as { subject?: string | null; customers?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null } | null;
      const turnStatus = (row.turn_status as TurnStatus) ?? "idle";
      const updatedAt = row.updated_at as string;
      const seenAt = (row.seen_at as string | null) ?? null;
      // Unread = the box answered since you last looked. Marking read sets seen_at = updated_at, so a
      // later turn (which bumps updated_at) makes updated_at > seen_at again → re-surfaces as unread.
      const unread = seenAt === null || new Date(updatedAt).getTime() > new Date(seenAt).getTime();
      return {
        ticket_id: row.ticket_id as string,
        subject: ticket?.subject ?? null,
        customer_name: customerName(ticket?.customers ?? null),
        turn_status: turnStatus,
        queue_state: deriveState(turnStatus, row.messages),
        last_error: (row.last_error as string | null) ?? null,
        updated_at: updatedAt,
        unread,
      };
    })
    // 'idle' (no assistant-last, nothing waiting) isn't surfaced in either group.
    .filter((item) => item.queue_state !== "idle");

  const counts = {
    // The nav badge: unread waiting sessions (genuinely new box replies you haven't looked at).
    waiting: items.filter((i) => WAITING_STATES.includes(i.queue_state) && i.unread).length,
    in_progress: items.filter((i) => i.queue_state === "thinking").length,
  };

  return NextResponse.json({ items, counts });
}
