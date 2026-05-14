import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeAction, banUser, unbanUser } from "@/lib/social-comment-actions";

/**
 * GET — full comment detail for the dashboard detail view.
 * Includes the conversation thread, post context, page, AI suggestion.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id: workspaceId, commentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: comment, error } = await admin
    .from("social_comments")
    .select(
      `*,
       meta_pages!inner(meta_page_name, platform, page_type),
       products(title, handle, description),
       meta_post_cache(permalink_url, message, image_url, posted_at, is_ad)`,
    )
    .eq("workspace_id", workspaceId)
    .eq("id", commentId)
    .single();

  if (error || !comment) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

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

  return NextResponse.json({
    comment,
    replies: replies || [],
    sender_history: senderHistory || [],
    sender_banned: !!ban,
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    .select("id, workspace_id, meta_page_id, meta_comment_id, meta_sender_id, meta_sender_name, meta_sender_username")
    .eq("workspace_id", workspaceId)
    .eq("id", commentId)
    .single();
  if (!comment) return NextResponse.json({ error: "Comment not found" }, { status: 404 });

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
