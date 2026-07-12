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
import { createThread, loadThread, markThreadThinking, setActionDecision, listRecentThreads, type DirectorCoachThread } from "@/lib/agents/director-coach-threads";
import { getSlackToken, postMessage, updateMessage } from "@/lib/slack";
import { buildAdaResolvedCard } from "@/lib/slack-ada";
import { getOrgChart } from "@/lib/agents/org-chart";
import { getLeashGuide } from "@/lib/agents/director-leash-guide";

const DEFAULT_DIRECTOR = "platform"; // backward-compat for the Ask-Ada button (no director_function in body).

/**
 * Live + leashed director allowlist for a new coach thread. A caller-supplied `director_function` must be
 * a slug the org-chart marks `live` AND that has a registered leash module in director-leash-guide.ts — no
 * client can start a coach thread with a director whose backend can't back it up. Absent field → the
 * default 'platform' (unpin Phase 1: generalize-director-coach-backend spec).
 */
async function liveLeashedDirectorSlugs(): Promise<Set<string>> {
  const chart = await getOrgChart();
  return new Set(chart.directors.filter((d) => d.live && getLeashGuide(d.slug).defined).map((d) => d.slug));
}

// ── ada-slack-chat: keep a #cto-ada thread's Slack side in sync with web actions ──
// A thread that started in Slack (source='slack') stays a single conversation visible on BOTH surfaces.
// So a web-typed reply is relayed INTO the Slack thread, and a web-side approve/reject resolves the Slack
// card. (Ada's own replies already mirror to Slack from the box — postCoachTurnToSlack.)

/** Relay a web-typed CEO message into the Slack thread (clearly marked as relayed — Slack forbids posing
 *  as a real user). No-op for web-only threads. Best-effort: a Slack failure never blocks the web turn. */
async function relayCeoMessageToSlack(thread: DirectorCoachThread | null, workspaceId: string, userId: string, message: string): Promise<void> {
  if (!thread || thread.source !== "slack" || !thread.slack_channel_id) return;
  try {
    const token = await getSlackToken(workspaceId);
    if (!token) return;
    const admin = createAdminClient();
    const { data: m } = await admin.from("workspace_members").select("display_name").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
    const name = ((m?.display_name as string | undefined) || "").trim() || "CEO";
    const quoted = message.replace(/\n/g, "\n> ");
    await postMessage(token, thread.slack_channel_id, [], `💬 *${name}* replied from ShopCX:\n> ${quoted}`, { thread_ts: thread.slack_thread_ts ?? undefined });
  } catch (e) {
    console.error("[director-coach] relayCeoMessageToSlack failed:", e instanceof Error ? e.message : e);
  }
}

/** Resolve the Slack approval card in place when the CEO decides it from the web (no stale buttons). */
async function resolveSlackCardFromWeb(thread: DirectorCoachThread | null, workspaceId: string, actionId: string, decision: "approve" | "decline"): Promise<void> {
  if (!thread || thread.source !== "slack" || !thread.slack_channel_id) return;
  const card = thread.pending_actions.find((a) => a.id === actionId);
  if (!card?.slackTs) return;
  try {
    const token = await getSlackToken(workspaceId);
    if (!token) return;
    const rebuilt = buildAdaResolvedCard({ id: card.id, type: card.type, summary: card.summary, guidance: card.guidance }, decision);
    await updateMessage(token, thread.slack_channel_id, card.slackTs, rebuilt.blocks, rebuilt.text);
  } catch (e) {
    console.error("[director-coach] resolveSlackCardFromWeb failed:", e instanceof Error ? e.message : e);
  }
}

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

async function enqueue(opts: { workspaceId: string; userId: string; threadId: string; mode: "turn" | "approve_action"; intent?: "ask" | "coach" | "plan" }) {
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
    intent?: "ask" | "coach" | "plan";
    director_function?: string;
  };
  const action = body.action ?? "chat";

  if (action === "approve") {
    if (!body.id || !body.actionId || !body.decision) return NextResponse.json({ error: "Missing id/actionId/decision" }, { status: 400 });
    const thread = await setActionDecision(g.workspaceId, body.id, body.actionId, body.decision);
    if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    await resolveSlackCardFromWeb(thread, g.workspaceId, body.actionId, body.decision);
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
    // Resolve the director this thread will run AS. Absent field → default 'platform' (Ask-Ada button
    // backward-compat). A client-supplied slug must be a live + leashed director — otherwise 400.
    const requested = typeof body.director_function === "string" && body.director_function.trim() ? body.director_function.trim() : undefined;
    let directorFunction = DEFAULT_DIRECTOR;
    if (requested) {
      const allow = await liveLeashedDirectorSlugs();
      if (!allow.has(requested)) return NextResponse.json({ error: "director_function not live-or-leashed" }, { status: 400 });
      directorFunction = requested;
    }
    const created = await createThread({ workspaceId: g.workspaceId, userId: g.userId, directorFunction, message });
    if (!created) return NextResponse.json({ error: "Could not create thread" }, { status: 500 });
    threadId = created.id;
  } else {
    const t = await markThreadThinking(g.workspaceId, threadId, message);
    if (!t) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    // ada-slack-chat: if this conversation lives in #cto-ada, relay the CEO's web reply into the Slack
    // thread so the transcript is identical on both surfaces, wherever each message was typed.
    await relayCeoMessageToSlack(t, g.workspaceId, g.userId, message);
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
