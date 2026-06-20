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
 *   error             → 'error'            (last_error set; sending again retries) ├─ "Waiting on you"
 *   idle + assistant-last message → 'answered' (the box replied, you haven't replied since) ┘
 *   thinking          → 'thinking'         (a turn is in flight)                  — "In progress"
 *   idle + no assistant-last → 'idle'      (nothing waiting — not surfaced)
 *
 * Gated to owner / admin / cs_manager (the same roles that can drive Improve — box-ticket-improve P4).
 * See docs/brain/specs/improve-queue.md.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    .select("ticket_id, turn_status, messages, last_error, updated_at, tickets(subject, customers(first_name, last_name, email))")
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
      return {
        ticket_id: row.ticket_id as string,
        subject: ticket?.subject ?? null,
        customer_name: customerName(ticket?.customers ?? null),
        turn_status: turnStatus,
        queue_state: deriveState(turnStatus, row.messages),
        last_error: (row.last_error as string | null) ?? null,
        updated_at: row.updated_at as string,
      };
    })
    // 'idle' (no assistant-last, nothing waiting) isn't surfaced in either group.
    .filter((item) => item.queue_state !== "idle");

  const counts = {
    waiting: items.filter((i) => WAITING_STATES.includes(i.queue_state)).length,
    in_progress: items.filter((i) => i.queue_state === "thinking").length,
  };

  return NextResponse.json({ items, counts });
}
