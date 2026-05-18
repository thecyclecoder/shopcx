/**
 * Action executor for the Meta comments moderation orchestrator.
 *
 * Takes a ModerationDecision + the social_comments row, fires the
 * matching Graph API call, and reconciles the database:
 *   - reply    → POST /{comment-id}/comments, insert reply row, status='replied'
 *   - like     → POST /{comment-id}/likes, set liked_at
 *   - hide     → POST /{comment-id} {is_hidden:true}, status='hidden'
 *   - delete   → DELETE /{comment-id}, status='deleted'
 *   - ignore   → no API call, status stays 'open', moderation_source recorded
 *   - escalate → status='escalated', assigned_to set via round-robin agent
 *   - ban_user → adds to banned_meta_users + auto-hides all existing comments
 *
 * Sandbox mode: when workspaces.sandbox_mode is on, we record the AI
 * suggestion fields on the social_comments row (ai_action / ai_reply_body /
 * ai_reasoning / ai_ran_at, moderation_source='ai_suggested') and do
 * NOT fire any Graph API call. An agent reviews and approves from the
 * detail view, which calls executeAgentAction() to actually fire.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import {
  replyToComment,
  hideComment,
  deleteComment,
  likeComment,
  blockUserOnFbPage,
  unblockUserOnFbPage,
} from "@/lib/meta";
import type { ModerationDecision, ModerationAction } from "@/lib/social-comment-orchestrator";

type Admin = ReturnType<typeof createAdminClient>;

interface SocialCommentRow {
  id: string;
  workspace_id: string;
  meta_page_id: string;
  meta_comment_id: string;
  meta_sender_id: string;
  meta_sender_name: string | null;
  meta_sender_username: string | null;
}

/**
 * Apply an AI moderation decision to a social_comments row.
 * Resolves sandbox vs live mode and dispatches to the right action.
 */
export async function applyModerationDecision(
  workspaceId: string,
  socialCommentId: string,
  decision: ModerationDecision,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();

  const [{ data: workspace }, { data: comment }] = await Promise.all([
    admin.from("workspaces").select("sandbox_mode").eq("id", workspaceId).single(),
    admin
      .from("social_comments")
      .select("id, workspace_id, meta_page_id, meta_comment_id, meta_sender_id, meta_sender_name, meta_sender_username")
      .eq("id", socialCommentId)
      .single(),
  ]);

  if (!comment) return { ok: false, error: "social_comments row not found" };

  // Always stamp the AI fields so the detail view can render the
  // suggestion card regardless of sandbox vs live.
  await admin
    .from("social_comments")
    .update({
      ai_action: decision.action,
      ai_reply_body: decision.reply_body,
      ai_reasoning: decision.reasoning,
      ai_ran_at: new Date().toISOString(),
      sentiment: decision.sentiment,
    })
    .eq("id", socialCommentId);

  if (workspace?.sandbox_mode) {
    await admin
      .from("social_comments")
      .update({ moderation_source: "ai_suggested" })
      .eq("id", socialCommentId);
    return { ok: true };
  }

  return executeAction({
    admin,
    comment,
    action: decision.action,
    replyBody: decision.reply_body,
    actorUserId: null,
    moderationSource: "ai_auto",
    banUser: decision.ban_user,
    banReason: decision.ban_reason,
  });
}

interface ExecuteArgs {
  admin: Admin;
  comment: SocialCommentRow;
  action: ModerationAction;
  replyBody: string | null;
  actorUserId: string | null;
  moderationSource: "ai_auto" | "agent_manual" | "rule";
  banUser?: boolean;
  banReason?: string | null;
}

/**
 * Fire the Graph API call + reconcile the DB row.
 * Used by both the orchestrator (live mode) and the agent dashboard
 * (sandbox approval, manual moderation).
 */
export async function executeAction(args: ExecuteArgs): Promise<{ ok: boolean; error?: string }> {
  const { admin, comment, action, replyBody, actorUserId, moderationSource } = args;
  const now = new Date().toISOString();

  const token = await loadPageAccessToken(admin, comment.meta_page_id);
  if (!token && action !== "ignore" && action !== "escalate") {
    return { ok: false, error: "Page access token not available" };
  }

  switch (action) {
    case "reply": {
      if (!replyBody || !token) {
        return { ok: false, error: "Reply body required" };
      }
      // Pre-write the outbound reply row so an agent can see "pending"
      // immediately even if the Graph API call is slow / fails.
      const { data: replyRow } = await admin
        .from("social_comment_replies")
        .insert({
          workspace_id: comment.workspace_id,
          social_comment_id: comment.id,
          meta_sender_id: null,
          direction: "outbound",
          author_type: moderationSource === "ai_auto" ? "ai" : "agent",
          author_user_id: actorUserId,
          body: replyBody,
          send_status: "pending",
        })
        .select("id")
        .single();

      const result = await replyToComment(token!, comment.meta_comment_id, replyBody);
      if (result.error) {
        if (replyRow) {
          await admin
            .from("social_comment_replies")
            .update({ send_status: "failed", send_error: result.error })
            .eq("id", replyRow.id);
        }
        return { ok: false, error: result.error };
      }

      if (replyRow) {
        await admin
          .from("social_comment_replies")
          .update({ send_status: "sent", meta_reply_id: result.commentId || null })
          .eq("id", replyRow.id);
      }

      await admin
        .from("social_comments")
        .update({
          status: "replied",
          moderation_source: moderationSource,
          replied_at: now,
          replied_by: actorUserId,
          updated_at: now,
        })
        .eq("id", comment.id);
      break;
    }

    case "like": {
      const result = await likeComment(token!, comment.meta_comment_id);
      if (!result.success) return { ok: false, error: result.error };
      await admin
        .from("social_comments")
        .update({
          liked_at: now,
          moderation_source: moderationSource,
          updated_at: now,
        })
        .eq("id", comment.id);
      break;
    }

    case "hide": {
      const result = await hideComment(token!, comment.meta_comment_id, true);
      if (!result.success) return { ok: false, error: result.error };
      await admin
        .from("social_comments")
        .update({
          status: "hidden",
          moderation_source: moderationSource,
          hidden_at: now,
          hidden_by: actorUserId,
          updated_at: now,
        })
        .eq("id", comment.id);
      break;
    }

    case "delete": {
      const result = await deleteComment(token!, comment.meta_comment_id);
      if (!result.success) return { ok: false, error: result.error };
      await admin
        .from("social_comments")
        .update({
          status: "deleted",
          moderation_source: moderationSource,
          deleted_at: now,
          deleted_by: actorUserId,
          updated_at: now,
        })
        .eq("id", comment.id);
      break;
    }

    case "ignore": {
      // Status stays 'open' so the queue isn't misleading, but a
      // separate moderation_source='ai_auto' flags that AI looked at
      // it and decided no action. Dashboard filters can hide these.
      await admin
        .from("social_comments")
        .update({
          status: "ignored",
          moderation_source: moderationSource,
          updated_at: now,
        })
        .eq("id", comment.id);
      break;
    }

    case "escalate": {
      const assignee = await pickAgent(admin, comment.workspace_id);
      await admin
        .from("social_comments")
        .update({
          status: "escalated",
          moderation_source: moderationSource,
          assigned_to: assignee,
          updated_at: now,
        })
        .eq("id", comment.id);
      break;
    }
  }

  // Auto-ban after action — fires regardless of which action we took
  // so an AI deciding "delete + ban" works in one shot.
  if (args.banUser) {
    await banUser({
      admin,
      workspaceId: comment.workspace_id,
      senderId: comment.meta_sender_id,
      senderName: comment.meta_sender_name,
      senderUsername: comment.meta_sender_username,
      reason: args.banReason ?? null,
      bannedBy: actorUserId,
      hideAllExisting: true,
    });
  }

  return { ok: true };
}

interface BanArgs {
  admin: Admin;
  workspaceId: string;
  senderId: string;
  senderName: string | null;
  senderUsername: string | null;
  reason: string | null;
  bannedBy: string | null;
  hideAllExisting: boolean;
}

/**
 * Add a sender to the workspace's ban list and (optionally) hide every
 * comment they've already left. Idempotent — if the row already exists
 * we update reason/banned_by and clear unbanned_at if previously unbanned.
 */
export async function banUser(args: BanArgs): Promise<void> {
  const { admin } = args;
  await admin.from("banned_meta_users").upsert(
    {
      workspace_id: args.workspaceId,
      meta_sender_id: args.senderId,
      sender_name: args.senderName,
      sender_username: args.senderUsername,
      reason: args.reason,
      banned_by: args.bannedBy,
      banned_at: new Date().toISOString(),
      unbanned_at: null,
      unbanned_by: null,
    },
    { onConflict: "workspace_id,meta_sender_id" },
  );

  // Real Meta-side block on every FB page in the workspace. This stops
  // the user from commenting on the Page, prevents them from seeing the
  // Page's ads, and blocks messaging. IG has no equivalent API — for
  // Instagram users we fall back to hiding existing comments and
  // skipping future ones via banned_meta_users.
  const { data: pages } = await admin
    .from("meta_pages")
    .select("id, meta_page_id, platform")
    .eq("workspace_id", args.workspaceId)
    .eq("is_active", true);
  for (const p of pages || []) {
    if (p.platform !== "facebook") continue;
    const token = await loadPageAccessToken(admin, p.id);
    if (!token) continue;
    const r = await blockUserOnFbPage(token, p.meta_page_id, args.senderId);
    if (!r.success) console.warn(`Block on page ${p.meta_page_id} failed:`, r.error);
  }

  if (!args.hideAllExisting) return;

  // Hide every still-public comment by this user across every page in
  // the workspace. Fetch in one pass, hide one at a time — small lists
  // in practice; if it grows we'll batch.
  const { data: pending } = await admin
    .from("social_comments")
    .select("id, meta_comment_id, meta_page_id, status")
    .eq("workspace_id", args.workspaceId)
    .eq("meta_sender_id", args.senderId)
    .in("status", ["open", "replied", "ignored", "escalated"]);

  for (const c of pending || []) {
    const token = await loadPageAccessToken(admin, c.meta_page_id);
    if (token) await hideComment(token, c.meta_comment_id, true);
    await admin
      .from("social_comments")
      .update({
        status: "hidden",
        moderation_source: "rule",
        hidden_at: new Date().toISOString(),
        hidden_by: args.bannedBy,
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id);
  }
}

export async function unbanUser(
  workspaceId: string,
  senderId: string,
  actorUserId: string | null,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("banned_meta_users")
    .update({
      unbanned_at: new Date().toISOString(),
      unbanned_by: actorUserId,
    })
    .eq("workspace_id", workspaceId)
    .eq("meta_sender_id", senderId);

  // Reverse the FB Page block(s). IG has no programmatic block, so this
  // is a no-op there — the internal ban list is the only artifact.
  const { data: pages } = await admin
    .from("meta_pages")
    .select("id, meta_page_id, platform")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  for (const p of pages || []) {
    if (p.platform !== "facebook") continue;
    const token = await loadPageAccessToken(admin, p.id);
    if (!token) continue;
    const r = await unblockUserOnFbPage(token, p.meta_page_id, senderId);
    if (!r.success) console.warn(`Unblock on page ${p.meta_page_id} failed:`, r.error);
  }
}

async function loadPageAccessToken(admin: Admin, metaPagesId: string): Promise<string | null> {
  const { data: page } = await admin
    .from("meta_pages")
    .select("access_token_encrypted")
    .eq("id", metaPagesId)
    .single();
  if (!page?.access_token_encrypted) return null;
  try {
    return decrypt(page.access_token_encrypted);
  } catch {
    return null;
  }
}

/**
 * Round-robin agent assignment for escalations.
 * Picks the workspace member with the lowest currently-open escalated
 * comment count — same fairness model as the ticket escalation flow.
 */
async function pickAgent(admin: Admin, workspaceId: string): Promise<string | null> {
  const { data: members } = await admin
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin", "agent", "social"]);
  if (!members?.length) return null;

  // Count current escalated load per member.
  const { data: load } = await admin
    .from("social_comments")
    .select("assigned_to")
    .eq("workspace_id", workspaceId)
    .eq("status", "escalated");
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.user_id, 0);
  for (const c of load || []) {
    if (c.assigned_to) counts.set(c.assigned_to as string, (counts.get(c.assigned_to as string) || 0) + 1);
  }
  let chosen: string | null = null;
  let lowest = Infinity;
  for (const [uid, n] of counts) {
    if (n < lowest) { lowest = n; chosen = uid; }
  }
  return chosen;
}
