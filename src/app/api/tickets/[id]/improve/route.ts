/**
 * /api/tickets/[id]/improve — the box-hosted Improve agent (box-ticket-improve).
 *
 * The Improve tab is a ticket-bound, resumable Max session. This route no longer calls the Anthropic
 * API. Instead:
 *   POST { action:'send', message }   → append the user message to the ticket's improve session, set
 *                                        turn_status='thinking', enqueue a kind='ticket-improve' job
 *                                        ({ticket_id, session_id, mode:'turn', user_message}). The box
 *                                        (Max `claude -p`) investigates read-only + replies or proposes
 *                                        a typed action plan into pending_plan. Returns the session.
 *   POST { action:'execute', decisions? } → execute the APPROVED plan server-side (this runtime holds
 *                                        prod creds) via the existing improve executors, post the
 *                                        result, clear the plan. The box never mutates.
 *   GET                                → the ticket's session (poll target).
 *
 * Gated to owner / admin / cs_manager (the CX manager can drive it — box-ticket-improve P4).
 * See docs/brain/specs/box-ticket-improve.md.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import {
  loadOrCreateSession,
  loadSession,
  patchSession,
  type ChatMsg,
  type ImprovePlanAction,
} from "@/lib/ticket-improve-chats";
import { executeImprovePlan } from "@/lib/improve-plan-executor";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];

async function authTicket(ticketId: string) {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !ALLOWED_ROLES.includes(member.role)) {
    return { error: NextResponse.json({ error: "Owner, admin, or CS manager role required" }, { status: 403 }) };
  }

  const { data: ticket } = await admin
    .from("tickets")
    .select("id")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();
  if (!ticket) return { error: NextResponse.json({ error: "Ticket not found" }, { status: 404 }) };

  return { user, workspaceId, role: member.role as string };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: ticketId } = await params;
  const auth = await authTicket(ticketId);
  if ("error" in auth) return auth.error;
  const session = await loadSession(auth.workspaceId, ticketId);
  return NextResponse.json({ session });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: ticketId } = await params;
  const auth = await authTicket(ticketId);
  if ("error" in auth) return auth.error;
  const { workspaceId, user } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    action?: "send" | "execute";
    message?: string;
    decisions?: Record<string, "approve" | "decline">;
  };
  const action = body.action || (body.message ? "send" : undefined);

  // ── Send a turn: append the user message, enqueue a box investigation/proposal job ──
  if (action === "send") {
    const message = (body.message || "").trim();
    if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

    const session = await loadOrCreateSession(workspaceId, ticketId, user.id);
    if (!session) return NextResponse.json({ error: "session create failed" }, { status: 500 });
    if (session.turn_status === "thinking") {
      return NextResponse.json({ error: "A turn is already in progress", session }, { status: 409 });
    }

    const messages: ChatMsg[] = [...session.messages, { role: "user", content: message }];
    // Sending a new instruction while a plan was parked = a pivot/redirect: drop the old plan.
    const updated = await patchSession(workspaceId, session.id, {
      messages,
      turn_status: "thinking",
      pending_plan: null,
      last_error: null,
    });

    const admin = createAdminClient();
    await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: session.id, // the improve-session id is the job's subject
      kind: "ticket-improve",
      status: "queued",
      instructions: JSON.stringify({ ticket_id: ticketId, session_id: session.id, mode: "turn", user_message: message }),
      created_by: user.id,
    });

    return NextResponse.json({ session: updated });
  }

  // ── Execute the approved plan (server-side, trusted runtime) ──
  if (action === "execute") {
    const session = await loadSession(workspaceId, ticketId);
    if (!session || !session.pending_plan) {
      return NextResponse.json({ error: "No plan to execute" }, { status: 400 });
    }
    const decisions = body.decisions || {};
    // Default: approve every pending action. Per-action decline supported via `decisions`.
    const planActions: ImprovePlanAction[] = session.pending_plan.actions.map((a) => ({
      ...a,
      status: decisions[a.id] === "decline" ? "declined" : a.status === "pending" ? "approved" : a.status,
    }));

    // Founder-gate the highest-blast-radius action: linking/merging customer
    // accounts is owner-only (not cs_manager, not admin). The box only ever
    // PROPOSES it; the founder must be the one to approve. (reassign + magic
    // link stay owner/admin/cs_manager — only the account merge is founder-gated.)
    const wantsAccountLink = planActions.some(
      (a) => a.status === "approved" && a.kind === "customer_action" && a.action?.type === "link_customer_accounts",
    );
    if (wantsAccountLink && auth.role !== "owner") {
      return NextResponse.json(
        { error: "Linking customer accounts is founder-gated — only the workspace owner can approve a link_customer_accounts action." },
        { status: 403 },
      );
    }

    const { actions, results, resolved } = await executeImprovePlan(workspaceId, ticketId, planActions);

    const declinedCount = actions.filter((a) => a.status === "declined").length;
    const summaryLines = [
      "Done.",
      ...results.map((r) => `• ${r}`),
      declinedCount ? `(${declinedCount} action${declinedCount > 1 ? "s" : ""} declined)` : null,
    ].filter(Boolean) as string[];
    const messages: ChatMsg[] = [...session.messages, { role: "assistant", content: summaryLines.join("\n") }];

    const updated = await patchSession(workspaceId, session.id, {
      messages,
      turn_status: "idle",
      pending_plan: null,
      ...(resolved ? { status: "resolved" } : {}),
    });

    return NextResponse.json({ session: updated, results });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
