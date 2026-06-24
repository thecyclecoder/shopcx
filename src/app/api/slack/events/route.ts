/**
 * Slack inbound — Events API + slash commands for the Slack Roadmap Console.
 *
 * Handles three slash commands (all pointed at this URL): `/roadmap [slug]` (read-only board /
 * detail), `/build <slug> [instructions]`, `/bug <slug> <desc>` (fix-build). Also answers the
 * Events API `url_verification` challenge so the same URL can be the Events Request URL.
 *
 * Every request is HMAC-verified (verifySlackSignature, ≤5 min skew). Mutating commands resolve
 * the Slack actor → ShopCX owner (slack-identity); the owner gate is then RE-checked server-side
 * inside roadmap-actions.ts — Slack identity is only a UX filter. The box is never contacted.
 *
 * See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md (Phases 1–4).
 */
import { NextResponse } from "next/server";
import { verifySlackSignature, resolveWorkspaceByTeamId, getSlackToken, postAsAda, addReaction } from "@/lib/slack";
import { resolveSlackActor, isOwner } from "@/lib/slack-identity";
import { queueRoadmapBuild } from "@/lib/roadmap-actions";
import { getRoadmap, getSpec } from "@/lib/brain-roadmap";
import { getLatestJobsBySlug, getPendingFolds } from "@/lib/agent-jobs";
import { buildBoardBlocks, buildSpecDetailBlocks } from "@/lib/slack-roadmap";
import { buildHomeView, publishHome } from "@/lib/slack-home";
import { createAdminClient } from "@/lib/supabase/admin";
import { createThread, markThreadThinking, findThreadBySlackThreadTs } from "@/lib/agents/director-coach-threads";

export const maxDuration = 60;

/** A Slack slash-command JSON reply (200). `in_channel` is visible to all; default is ephemeral. */
function reply(body: { response_type?: "in_channel" | "ephemeral"; text?: string; blocks?: unknown[] }) {
  return NextResponse.json(body);
}

function ephemeral(text: string) {
  return reply({ response_type: "ephemeral", text });
}

export async function POST(request: Request) {
  const raw = await request.text();
  const sig = request.headers.get("x-slack-signature");
  const ts = request.headers.get("x-slack-request-timestamp");
  if (!verifySlackSignature(raw, sig, ts)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  // Events API delivers JSON (url_verification challenge / event_callback); slash commands are form-encoded.
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = JSON.parse(raw) as {
      type?: string;
      challenge?: string;
      team_id?: string;
      event?: SlackEvent;
    };
    if (payload.type === "url_verification") return NextResponse.json({ challenge: payload.challenge });
    // app_home_opened (Home tab) → (re)publish the roadmap Home view for that user. Other events: ack only.
    if (payload.event?.type === "app_home_opened" && payload.event.tab === "home") {
      await publishHomeForUser(payload.team_id || "", payload.event.user || "");
    }
    // A message in #cto-ada → a director-coach turn (ada-slack-chat). Skip Slack's retry redeliveries:
    // we ack fast, so a retry would only double-enqueue the same message.
    if (payload.event?.type === "message" && !request.headers.get("x-slack-retry-num")) {
      await handleAdaMessage(payload.team_id || "", payload.event);
    }
    return NextResponse.json({ ok: true });
  }

  const form = new URLSearchParams(raw);
  const command = (form.get("command") || "").trim();
  const text = (form.get("text") || "").trim();
  const teamId = form.get("team_id") || "";
  const slackUserId = form.get("user_id") || "";

  const workspaceId = await resolveWorkspaceByTeamId(teamId);
  if (!workspaceId) return ephemeral("This Slack workspace isn't linked to a ShopCX workspace.");

  if (command === "/roadmap") return handleRoadmap(workspaceId, text);
  if (command === "/build") return handleBuild(workspaceId, slackUserId, text, false);
  if (command === "/bug") return handleBuild(workspaceId, slackUserId, text, true);
  if (command === "/ada-here") return handleAdaHere(workspaceId, slackUserId, form.get("channel_id") || "");
  return ephemeral(`Unknown command \`${command}\`.`);
}

// ── ada-slack-chat: #cto-ada two-way chat ──

/** The subset of a Slack Events API `message` event we read (+ the app_home_opened fields). */
interface SlackEvent {
  type?: string;
  tab?: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * `/ada-here` — run inside the channel you want to be #cto-ada. Owner-gated; saves the channel id on the
 * workspace so inbound messages there become coach turns. Confirms in-channel AS Ada (needs the bot invited).
 */
async function handleAdaHere(workspaceId: string, slackUserId: string, channelId: string) {
  const actor = await resolveSlackActor(workspaceId, slackUserId);
  if (!isOwner(actor)) return ephemeral("Owner-only — only the workspace owner can set Ada's channel.");
  if (!channelId) return ephemeral("Couldn't read this channel — run `/ada-here` inside the channel you want Ada to live in.");
  const admin = createAdminClient();
  const { error } = await admin.from("workspaces").update({ slack_ada_channel_id: channelId }).eq("id", workspaceId);
  if (error) return ephemeral(`Couldn't save: ${error.message}`);
  const token = await getSlackToken(workspaceId);
  if (token) await postAsAda(token, channelId, [], "👋 This is now my channel. Ask me anything — I'm your CTO.");
  return ephemeral("✅ Done — this channel is now wired to Ada. Try asking her something.");
}

/**
 * An inbound message in #cto-ada → one director-coach turn (intent='auto'), mirrored into the same web
 * coach thread. Loop-guarded (never re-trigger on Ada's own posts), channel-gated, and owner-gated.
 * Threading: a top-level post starts a new thread (keyed on its ts); a reply inside Ada's thread continues
 * the same conversation. Fast: a couple of DB writes + the 👀 ack, well within Slack's 3s window.
 */
async function handleAdaMessage(teamId: string, event: SlackEvent): Promise<void> {
  // Loop guard — never act on a bot message (Ada's own posts carry bot_id) or any non-plain message
  // subtype (edits/deletes/joins). This is what stops Ada answering Ada in an infinite loop.
  if (event.bot_id || event.subtype) return;
  const channel = event.channel;
  const slackUserId = event.user;
  const message = (event.text || "").trim();
  if (!channel || !slackUserId || !message || !event.ts) return;

  const workspaceId = await resolveWorkspaceByTeamId(teamId);
  if (!workspaceId) return;

  const admin = createAdminClient();
  // Channel gate — only the configured #cto-ada channel is Ada's chat surface.
  const { data: ws } = await admin.from("workspaces").select("slack_ada_channel_id").eq("id", workspaceId).maybeSingle();
  if (!ws?.slack_ada_channel_id || ws.slack_ada_channel_id !== channel) return;

  // Owner gate — only the founder talks to Ada; channel membership is NOT authorization.
  const actor = await resolveSlackActor(workspaceId, slackUserId);
  if (!isOwner(actor)) return;
  const userId = actor!.userId;

  // Threading: a reply (thread_ts set + ≠ own ts) continues the matching thread; anything else is a new
  // conversation keyed on this message's ts (which becomes the Slack thread root once Ada replies in).
  const isReply = !!event.thread_ts && event.thread_ts !== event.ts;
  let threadId: string;
  const existing = isReply ? await findThreadBySlackThreadTs(workspaceId, event.thread_ts!) : null;
  if (existing) {
    await markThreadThinking(workspaceId, existing.id, message);
    threadId = existing.id;
  } else {
    const created = await createThread({
      workspaceId,
      userId,
      message,
      source: "slack",
      slackChannelId: channel,
      slackThreadTs: isReply ? event.thread_ts! : event.ts,
    });
    if (!created) return;
    threadId = created.id;
  }

  // Enqueue the box turn — intent='auto' so Ada self-decides ask vs plan/coach/spec (ada-slack-chat P4).
  await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    kind: "director-coach",
    spec_slug: threadId,
    status: "queued",
    instructions: JSON.stringify({ thread_id: threadId, mode: "turn", intent: "auto" }),
    created_by: userId,
  });

  // 👀 ack so it reads as "received, thinking" while the box runs.
  const token = await getSlackToken(workspaceId);
  if (token) await addReaction(token, channel, event.ts, "eyes");
}

/** Publish the App Home roadmap view for a user that just opened the Home tab. Best-effort, fast (<3s). */
async function publishHomeForUser(teamId: string, slackUserId: string): Promise<void> {
  if (!teamId || !slackUserId) return;
  const workspaceId = await resolveWorkspaceByTeamId(teamId);
  if (!workspaceId) return;
  const token = await getSlackToken(workspaceId);
  if (!token) return;
  const view = await buildHomeView(workspaceId);
  await publishHome(token, slackUserId, view);
}

async function handleRoadmap(workspaceId: string, text: string) {
  const slug = text.split(/\s+/)[0]?.trim();
  if (slug) {
    const [found, jobs, folds] = await Promise.all([
      getSpec(slug),
      getLatestJobsBySlug(workspaceId),
      getPendingFolds(workspaceId),
    ]);
    if (!found) return ephemeral(`No spec \`${slug}\`. Try \`/roadmap\` for the board.`);
    const { blocks, text: fallback } = buildSpecDetailBlocks(found.card, jobs[slug] ?? null, folds[slug] ?? null);
    return reply({ response_type: "in_channel", blocks, text: fallback });
  }
  const [{ specs }, jobs, folds] = await Promise.all([
    getRoadmap(),
    getLatestJobsBySlug(workspaceId),
    getPendingFolds(workspaceId),
  ]);
  const { blocks, text: fallback } = buildBoardBlocks({ specs, jobs, folds });
  return reply({ response_type: "in_channel", blocks, text: fallback });
}

/** `/build <slug> [instructions]` and `/bug <slug> <desc>` — both queue a build, owner-gated twice. */
async function handleBuild(workspaceId: string, slackUserId: string, text: string, isBug: boolean) {
  const [slug, ...rest] = text.split(/\s+/);
  const detail = rest.join(" ").trim();
  if (!slug) return ephemeral(isBug ? "Usage: `/bug <slug> <description>`" : "Usage: `/build <slug> [instructions]`");
  if (isBug && !detail) return ephemeral("Usage: `/bug <slug> <description>` — describe the bug.");

  // UX filter: only the owner sees a real action; the service re-checks the gate regardless.
  const actor = await resolveSlackActor(workspaceId, slackUserId);
  if (!isOwner(actor)) return ephemeral("Owner-only — you can't start builds from here.");

  const instructions = isBug ? `Fix-build (bug reported via Slack): ${detail}` : detail || null;
  const result = await queueRoadmapBuild(workspaceId, actor!.userId, { slug, instructions });
  if (!result.ok) return ephemeral(`Couldn't queue \`${slug}\`: ${result.error}`);
  if (result.queuedBehindActive) {
    return ephemeral(`🐛 \`${slug}\` already has an active build — queued your fix as build \`${result.job.id.slice(0, 8)}\` to run next (nothing dropped).`);
  }
  if (result.alreadyActive) {
    return ephemeral(`\`${slug}\` already has an active build (${result.job.status}). One build per spec — let it finish first.`);
  }
  return ephemeral(isBug ? `🐛 Queued a fix-build for \`${slug}\`. I'll post here when it needs you.` : `🛠️ Queued a build for \`${slug}\`. I'll post here when it needs you.`);
}
