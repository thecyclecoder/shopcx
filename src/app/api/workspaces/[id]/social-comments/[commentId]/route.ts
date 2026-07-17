import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeAction, banUser, unbanUser } from "@/lib/social-comment-actions";
import { findCustomerCandidatesByMetaName } from "@/lib/social-comment-customer-match";

/**
 * GET — full comment detail for the dashboard detail view.
 * Includes the conversation thread, post context, page, AI suggestion.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id: workspaceId, commentId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // meta_post_cache has no FK from social_comments — join in JS instead
  // of using a PostgREST embed. (Cache row can legitimately be missing if
  // the Graph metadata fetch failed at ingest time.)
  const { data: commentRow, error } = await admin
    .from("social_comments")
    .select(
      `*,
       meta_pages!inner(meta_page_name, platform, page_type),
       products(title, handle, description)`,
    )
    .eq("workspace_id", workspaceId)
    .eq("id", commentId)
    .single();

  if (error || !commentRow) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  const { data: cacheRow } = await admin
    .from("meta_post_cache")
    .select("permalink_url, message, image_url, posted_at, is_ad")
    .eq("workspace_id", workspaceId)
    .eq("meta_post_id", (commentRow as { meta_post_id: string }).meta_post_id)
    .maybeSingle();
  const comment = { ...commentRow, meta_post_cache: cacheRow || null };

  const [{ data: replies }, { data: senderHistory }, { data: ban }] = await Promise.all([
    admin
      .from("social_comment_replies")
      .select("*")
      .eq("social_comment_id", commentId)
      .order("created_at", { ascending: true }),
    admin
      .from("social_comments")
      .select("id, body, status, sentiment, created_at")
      .eq("workspace_id", workspaceId)
      .eq("meta_sender_id", comment.meta_sender_id)
      .neq("id", commentId)
      .order("created_at", { ascending: false })
      .limit(10),
    admin
      .from("banned_meta_users")
      .select("id, banned_at, reason, unbanned_at")
      .eq("workspace_id", workspaceId)
      .eq("meta_sender_id", comment.meta_sender_id)
      .is("unbanned_at", null)
      .maybeSingle(),
  ]);

  // Find customer candidates by name (e.g. "Suzy Doucet" → "Suzanne
  // Doucet"). Then pull their recent tickets so the sidebar can show
  // clickable history per candidate.
  const candidates = await findCustomerCandidatesByMetaName(
    admin,
    workspaceId,
    (comment as { meta_sender_name: string | null }).meta_sender_name,
    (comment as { meta_sender_id: string | null }).meta_sender_id,
  );
  let recentTicketsByCustomer: Record<string, Array<{ id: string; subject: string | null; status: string; created_at: string; channel: string }>> = {};
  if (candidates.length) {
    const { data: tix } = await admin
      .from("tickets")
      .select("id, customer_id, subject, status, created_at, channel")
      .eq("workspace_id", workspaceId)
      .in("customer_id", candidates.map(c => c.id))
      .order("created_at", { ascending: false })
      .limit(50);
    recentTicketsByCustomer = (tix || []).reduce((acc, t) => {
      const k = t.customer_id as string;
      (acc[k] ||= []).push({
        id: t.id as string,
        subject: (t.subject as string | null) || null,
        status: t.status as string,
        created_at: t.created_at as string,
        channel: t.channel as string,
      });
      return acc;
    }, {} as typeof recentTicketsByCustomer);
    // Cap at 5 per candidate
    for (const k of Object.keys(recentTicketsByCustomer)) {
      recentTicketsByCustomer[k] = recentTicketsByCustomer[k].slice(0, 5);
    }
  }

  return NextResponse.json({
    comment,
    replies: replies || [],
    sender_history: senderHistory || [],
    sender_banned: !!ban,
    customer_candidates: candidates,
    recent_tickets_by_customer: recentTicketsByCustomer,
  });
}

/**
 * POST — agent moderation action.
 * Body:
 *   { action: 'reply'|'like'|'hide'|'delete'|'ignore'|'escalate'|'ban'|'unban',
 *     reply_body?: string, ban_reason?: string }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id: workspaceId, commentId } = await params;
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin", "agent", "social"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const action = body.action as string;

  const { data: comment } = await admin
    .from("social_comments")
    .select("id, workspace_id, meta_page_id, meta_comment_id, meta_sender_id, meta_sender_name, meta_sender_username, body, created_at, meta_post_id")
    .eq("workspace_id", workspaceId)
    .eq("id", commentId)
    .single();
  if (!comment) return NextResponse.json({ error: "Comment not found" }, { status: 404 });

  if (action === "flag_competitor") {
    // Agent-driven escalation: append competitor name(s) to the
    // workspace deny-list, then delete + ban the current commenter
    // exactly like Pass-1's competitor_promotion classification.
    const rawName = typeof body.competitor_name === "string" ? body.competitor_name.trim() : "";
    if (rawName) {
      const { data: ws } = await admin.from("workspaces")
        .select("social_competitor_keywords").eq("id", workspaceId).single();
      const existing = ((ws?.social_competitor_keywords as string | null) || "").trim();
      const existingLines = existing ? existing.split("\n").map((l: string) => l.trim().toLowerCase()) : [];
      // Accept comma- or newline-separated input from the prompt
      const newLines = rawName.split(/[\n,]+/).map((l: string) => l.trim()).filter(Boolean);
      const toAdd = newLines.filter((l: string) => !existingLines.includes(l.toLowerCase()));
      if (toAdd.length) {
        const merged = [existing, ...toAdd].filter(Boolean).join("\n");
        await admin.from("workspaces").update({ social_competitor_keywords: merged }).eq("id", workspaceId);
      }
    }
    // Delete + ban (re-using the executeAction path used by Pass-1)
    const result = await executeAction({
      admin, comment, action: "delete", replyBody: null,
      actorUserId: user.id, moderationSource: "agent_manual",
      banUser: true, banReason: `competitor promotion${rawName ? `: ${rawName}` : ""}`,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (action === "regenerate_ai") {
    const { moderateSocialComment } = await import("@/lib/social-comment-orchestrator");
    const humanHint = typeof body.human_context === "string" && body.human_context.trim()
      ? body.human_context.trim().slice(0, 800)
      : null;
    const decision = await moderateSocialComment(workspaceId, commentId, humanHint);
    await admin.from("social_comments").update({
      ai_action: decision.action,
      ai_reply_body: decision.reply_body,
      ai_reasoning: decision.reasoning,
      ai_ran_at: new Date().toISOString(),
      ai_visibility: decision.visibility,
      ai_considers: decision.considers,
      ai_kb_sources: decision.kb_sources,
      ai_model: decision.model,
      sentiment: decision.sentiment,
      moderation_source: "ai_suggested",
      updated_at: new Date().toISOString(),
    }).eq("id", commentId);
    return NextResponse.json({ ok: true, decision });
  }

  if (action === "set_status") {
    const next = String(body.status || "").toLowerCase();
    const ALLOWED = new Set(["open", "closed", "ignored"]);
    if (!ALLOWED.has(next)) {
      return NextResponse.json({ error: `status must be one of ${[...ALLOWED].join(", ")}` }, { status: 400 });
    }
    // Don't trample a row that's already been deleted/hidden on Meta —
    // those are end states tied to a Graph API action, not just UI bookkeeping.
    const { data: current } = await admin
      .from("social_comments").select("status").eq("id", commentId).single();
    if (current && ["hidden", "deleted"].includes(current.status as string)) {
      return NextResponse.json({ error: `Comment is ${current.status} — undo that first via Meta` }, { status: 400 });
    }
    await admin.from("social_comments")
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq("id", commentId);
    return NextResponse.json({ ok: true });
  }

  if (action === "link_customer") {
    const customerId = (body.customer_id as string) || null;
    if (!customerId) return NextResponse.json({ error: "customer_id required" }, { status: 400 });
    const { data: cust } = await admin.from("customers")
      .select("id").eq("workspace_id", workspaceId).eq("id", customerId).maybeSingle();
    if (!cust) return NextResponse.json({ error: "Customer not in this workspace" }, { status: 400 });

    // Persistent link — future comments from this Meta sender are
    // auto-stamped with this customer_id at ingest time.
    await admin.from("meta_sender_customer_links").upsert({
      workspace_id: workspaceId,
      meta_sender_id: comment.meta_sender_id,
      meta_sender_name: comment.meta_sender_name || null,
      customer_id: customerId,
      confirmed_by: user.id,
      confirmed_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,meta_sender_id" });

    // Stamp every existing comment from the same sender so historical
    // rows pick up the link without a re-ingest.
    await admin.from("social_comments")
      .update({ customer_id: customerId, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("meta_sender_id", comment.meta_sender_id);
    return NextResponse.json({ ok: true });
  }

  if (action === "unlink_customer") {
    await admin.from("meta_sender_customer_links")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("meta_sender_id", comment.meta_sender_id);
    await admin.from("social_comments")
      .update({ customer_id: null, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("meta_sender_id", comment.meta_sender_id);
    return NextResponse.json({ ok: true });
  }

  if (action === "assign") {
    const assigneeId = (body.assignee_id as string) || null;
    if (assigneeId) {
      // Confirm the assignee is a member of this workspace.
      const { data: m } = await admin.from("workspace_members")
        .select("user_id").eq("workspace_id", workspaceId).eq("user_id", assigneeId).maybeSingle();
      if (!m) return NextResponse.json({ error: "Assignee not a member of this workspace" }, { status: 400 });
    }
    await admin.from("social_comments")
      .update({
        status: assigneeId ? "escalated" : "open",
        assigned_to: assigneeId,
        moderation_source: "agent_manual",
        updated_at: new Date().toISOString(),
      })
      .eq("id", commentId);
    return NextResponse.json({ ok: true });
  }

  if (action === "create_ticket") {
    const customerId = (body.customer_id as string) || null;
    if (!customerId) return NextResponse.json({ error: "customer_id required" }, { status: 400 });

    // Confirm the customer belongs to this workspace before we wire it
    // to a ticket — keep workspace scoping airtight.
    const { data: cust } = await admin
      .from("customers")
      .select("id, email, first_name, last_name")
      .eq("workspace_id", workspaceId)
      .eq("id", customerId)
      .maybeSingle();
    if (!cust) return NextResponse.json({ error: "Customer not in this workspace" }, { status: 400 });

    // Derive a short subject from the comment body. Fall back to a
    // generic title when the body is empty (rare but possible).
    const rawBody = (comment as { body: string | null }).body || "";
    const firstLine = rawBody.split(/\n/)[0].trim();
    const subject = firstLine
      ? firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine
      : `Public comment from ${comment.meta_sender_name || "customer"}`;

    const { data: ticket, error: terr } = await admin
      .from("tickets")
      .insert({
        workspace_id: workspaceId,
        customer_id: customerId,
        channel: "social_comments",
        status: "open",
        subject,
        meta_post_id: (comment as { meta_post_id: string | null }).meta_post_id,
        meta_comment_id: comment.meta_comment_id,
        meta_sender_id: comment.meta_sender_id,
        last_customer_reply_at: (comment as { created_at: string }).created_at,
      })
      .select("id")
      .single();
    if (terr || !ticket) return NextResponse.json({ error: terr?.message || "Ticket create failed" }, { status: 500 });

    // Copy the comment body over as the inbound first message so the
    // ticket reads as a real conversation start, not an empty thread.
    await admin.from("ticket_messages").insert({
      ticket_id: ticket.id,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: rawBody || `<no message body>`,
      created_at: (comment as { created_at: string }).created_at,
    });

    return NextResponse.json({ ok: true, ticket_id: ticket.id });
  }

  if (action === "ban") {
    await banUser({
      admin,
      workspaceId,
      senderId: comment.meta_sender_id,
      senderName: comment.meta_sender_name,
      senderUsername: comment.meta_sender_username,
      reason: body.ban_reason || null,
      bannedBy: user.id,
      hideAllExisting: true,
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "unban") {
    await unbanUser(workspaceId, comment.meta_sender_id, user.id);
    return NextResponse.json({ ok: true });
  }

  if (!["reply", "like", "hide", "delete", "ignore", "escalate"].includes(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const result = await executeAction({
    admin,
    comment,
    action: action as "reply" | "like" | "hide" | "delete" | "ignore" | "escalate",
    replyBody: body.reply_body || null,
    actorUserId: user.id,
    moderationSource: "agent_manual",
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
