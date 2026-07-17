/**
 * /api/roadmap/chat-session — persist + resume the Opus authoring chat (public.roadmap_chats).
 *
 *   POST { id?, spec_slug?, title, messages, status? } → upsert the session → { id }
 *   GET  ?id=<uuid>   → load one session
 *   GET  ?slug=<spec> → the latest `active` session for that spec (refine resume)
 *   GET  (no params)  → recent active sessions for the user/workspace (resume list)
 *
 * Owner-gated + workspace-scoped, mirroring the other roadmap routes' auth. Transcripts are plain
 * conversation (no secrets). See docs/brain/specs/authoring-chat-persistence.md (Phase 2).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  saveChat,
  loadChat,
  loadActiveChatForSlug,
  listRecentChats,
  type ChatMsg,
  type ChatStatus,
} from "@/lib/roadmap-chats";

async function requireOwner() {
  const { user } = await getAuthedUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can author specs" }, { status: 403 }) };
  }
  return { user, workspaceId };
}

const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9-]+$/i.test(s);

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    spec_slug?: string | null;
    title?: string | null;
    messages?: ChatMsg[];
    status?: ChatStatus;
  };

  const id = typeof body.id === "string" && body.id ? body.id : undefined;
  const messages = Array.isArray(body.messages) ? body.messages.slice(-200) : [];
  const specSlug = body.spec_slug === null ? null : isSlug(body.spec_slug) ? body.spec_slug : undefined;
  const status: ChatStatus | undefined = body.status === "active" || body.status === "finalized" ? body.status : undefined;
  const title = typeof body.title === "string" ? body.title.slice(0, 200) : undefined;

  const saved = await saveChat({
    id,
    workspaceId: auth.workspaceId,
    userId: auth.user.id,
    specSlug,
    title,
    messages,
    status,
  });
  if (!saved) return NextResponse.json({ error: "save failed" }, { status: 500 });
  return NextResponse.json({ id: saved.id, session: saved });
}

export async function GET(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const slug = url.searchParams.get("slug");

  if (id) {
    const session = await loadChat(auth.workspaceId, id);
    return NextResponse.json({ session });
  }
  if (slug) {
    if (!isSlug(slug)) return NextResponse.json({ session: null });
    const session = await loadActiveChatForSlug(auth.workspaceId, slug);
    return NextResponse.json({ session });
  }
  const sessions = await listRecentChats(auth.workspaceId, auth.user.id);
  return NextResponse.json({ sessions });
}
