/**
 * /api/developer/agents/board — the workspace's #directors board channel
 * (directors-board-gamified spec, Phases 1–2).
 *
 * Owner-gated. The Slack-style team channel behind the Messages tab of the M1 Agents-hub inbox: a
 * workspace's [[director_messages]] threaded into top-level posts (newest-first) with their replies.
 * It's ONE shared channel — every role's Messages tab renders it (the team board, not a per-role log).
 *
 *   GET  → { posts: BoardPost[] }  (a CEO `reply` whose answer-brain turn is still running carries awaiting:true)
 *   POST → { post } reply under a director's post → routes to dev-ask | spec-chat; the box posts the answer back.
 *
 * Two-way replies REUSE the existing answer brains (dev-ask [[dev-message-threads]] / spec-chat
 * [[roadmap-chats]]) — no parallel LLM path. See docs/brain/tables/director_messages.md + docs/brain/dashboard/agents.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDirectorBoard, routeBoardReply, enrichAwaiting } from "@/lib/agents/director-board";
import { threadMessages, type BoardPayload } from "@/lib/agents/board";


async function requireOwner() {
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
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can view the #directors board" }, { status: 403 }) };
  }
  return { user, workspaceId };
}

export async function GET() {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;

  const rows = await getDirectorBoard(auth.workspaceId);
  await enrichAwaiting(rows);
  const payload: BoardPayload = { posts: threadMessages(rows) };
  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    parentMessageId?: string;
    body?: string;
    mentions?: string[];
  };
  const parentMessageId = typeof body.parentMessageId === "string" ? body.parentMessageId : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!parentMessageId || !text) {
    return NextResponse.json({ error: "parentMessageId and body required" }, { status: 400 });
  }

  const mentions = Array.isArray(body.mentions)
    ? body.mentions.filter((m): m is string => typeof m === "string")
    : undefined;
  const result = await routeBoardReply({ workspaceId, userId: user.id, parentMessageId, body: text, mentions });
  if ("error" in result) {
    const status = result.error === "parent post not found" ? 404 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ post: result.ceoMessage, threadKind: result.threadKind });
}
