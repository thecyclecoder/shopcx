/**
 * /api/director/coach — the CEO↔Director coaching chat (worker-grading-and-director-management Phase 7).
 *
 * Owner-gated, workspace-scoped. Mirrors /api/developer/messages: each turn enqueues a kind='director-coach'
 * agent_jobs row the build box runs as a resumable Max session AS the director, who explains her decisions
 * read-only; the CEO coaches her and a proposed `coaching` card stops at an approval gate.
 *
 *   POST { message, id?, action?:"chat" }                  → new/continued turn
 *   POST { id, action:"retry" }                            → re-run an errored turn (no new message)
 *   POST { id, actionId, decision:"approve"|"decline", action:"approve" } → decide a card (approve → execute)
 *   GET  ?id=<uuid>                                        → load one thread
 *   GET                                                    → list recent threads (resume list)
 *
 * See docs/brain/tables/director_coach_threads.md · docs/brain/libraries/director-instructions.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createThread, loadThread, markThreadThinking, setActionDecision, listRecentThreads } from "@/lib/agents/director-coach-threads";

export const dynamic = "force-dynamic";

const DIRECTOR = "platform"; // the only live director today

async function gate(): Promise<{ ok: false; res: NextResponse } | { ok: true; workspaceId: string; userId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { ok: false, res: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") return { ok: false, res: NextResponse.json({ error: "Owner only" }, { status: 403 }) };
  return { ok: true, workspaceId, userId: user.id };
}

async function enqueue(opts: { workspaceId: string; userId: string; threadId: string; mode: "turn" | "approve_action"; intent?: "ask" | "coach" }) {
  const admin = createAdminClient();
  await admin.from("agent_jobs").insert({
    workspace_id: opts.workspaceId,
    kind: "director-coach",
    spec_slug: opts.threadId,
    status: "queued",
    // intent='coach' makes the box distill this into a coaching card for confirmation; 'ask' just explains.
    instructions: JSON.stringify({ thread_id: opts.threadId, mode: opts.mode, intent: opts.intent ?? "ask" }),
    created_by: opts.userId,
  });
}

export async function POST(req: Request) {
  const g = await gate();
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    action?: "chat" | "retry" | "approve";
    actionId?: string;
    decision?: "approve" | "decline";
    intent?: "ask" | "coach";
  };
  const action = body.action ?? "chat";

  if (action === "approve") {
    if (!body.id || !body.actionId || !body.decision) return NextResponse.json({ error: "Missing id/actionId/decision" }, { status: 400 });
    const thread = await setActionDecision(g.workspaceId, body.id, body.actionId, body.decision);
    if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    if (body.decision === "approve") await enqueue({ workspaceId: g.workspaceId, userId: g.userId, threadId: body.id, mode: "approve_action" });
    return NextResponse.json({ thread });
  }

  if (action === "retry") {
    if (!body.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
    const thread = await markThreadThinking(g.workspaceId, body.id);
    if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    await enqueue({ workspaceId: g.workspaceId, userId: g.userId, threadId: body.id, mode: "turn" });
    return NextResponse.json({ thread });
  }

  // chat
  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "Empty message" }, { status: 400 });
  let threadId = body.id;
  if (!threadId) {
    const created = await createThread({ workspaceId: g.workspaceId, userId: g.userId, directorFunction: DIRECTOR, message });
    if (!created) return NextResponse.json({ error: "Could not create thread" }, { status: 500 });
    threadId = created.id;
  } else {
    const t = await markThreadThinking(g.workspaceId, threadId, message);
    if (!t) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  await enqueue({ workspaceId: g.workspaceId, userId: g.userId, threadId: threadId as string, mode: "turn", intent: body.intent ?? "ask" });
  const thread = await loadThread(g.workspaceId, threadId as string);
  return NextResponse.json({ thread });
}

export async function GET(req: Request) {
  const g = await gate();
  if (!g.ok) return g.res;
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const thread = await loadThread(g.workspaceId, id);
    if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ thread });
  }
  const threads = await listRecentThreads(g.workspaceId, g.userId);
  return NextResponse.json({ threads });
}
