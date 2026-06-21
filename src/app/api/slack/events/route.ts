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
import { verifySlackSignature, resolveWorkspaceByTeamId, getSlackToken } from "@/lib/slack";
import { resolveSlackActor, isOwner } from "@/lib/slack-identity";
import { queueRoadmapBuild } from "@/lib/roadmap-actions";
import { getRoadmap, getSpec } from "@/lib/brain-roadmap";
import { getLatestJobsBySlug, getPendingFolds } from "@/lib/agent-jobs";
import { buildBoardBlocks, buildSpecDetailBlocks } from "@/lib/slack-roadmap";
import { buildHomeView, publishHome } from "@/lib/slack-home";

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
      event?: { type?: string; tab?: string; user?: string };
    };
    if (payload.type === "url_verification") return NextResponse.json({ challenge: payload.challenge });
    // app_home_opened (Home tab) → (re)publish the roadmap Home view for that user. Other events: ack only.
    if (payload.event?.type === "app_home_opened" && payload.event.tab === "home") {
      await publishHomeForUser(payload.team_id || "", payload.event.user || "");
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
  return ephemeral(`Unknown command \`${command}\`.`);
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
  if (result.alreadyActive) {
    return ephemeral(`\`${slug}\` already has an active build (${result.job.status}). One build per spec — let it finish first.`);
  }
  const buildId = result.job.id.slice(0, 8);
  return ephemeral(isBug ? `🐛 Issue queued as build \`${buildId}\` for \`${slug}\`. I'll post here when it needs you.` : `🛠️ Queued build \`${buildId}\` for \`${slug}\`. I'll post here when it needs you.`);
}
