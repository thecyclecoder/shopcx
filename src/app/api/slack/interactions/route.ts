/**
 * Slack inbound — interactivity (block_actions + view_submission) for the Slack Roadmap Console.
 *
 * Button taps (Build / Answer / Approve / Decline / Squash & merge) and the answer modal's submit
 * land here. Every request is HMAC-verified (verifySlackSignature, ≤5 min skew). Mutating actions
 * resolve the Slack actor → ShopCX owner (slack-identity) as a UX filter; the owner gate is then
 * RE-checked server-side inside roadmap-actions.ts. The box is never contacted — we only write
 * agent_jobs / call the same routes the dashboard does.
 *
 * See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md (Phases 1–4).
 */
import { NextResponse } from "next/server";
import {
  verifySlackSignature,
  resolveWorkspaceByTeamId,
  getSlackToken,
  postEphemeral,
  updateMessage,
  openModal,
} from "@/lib/slack";
import { resolveSlackActor, isOwner } from "@/lib/slack-identity";
import { queueRoadmapBuild, approveRoadmapAction, mergeClaudePr, answerRoadmapBuild } from "@/lib/roadmap-actions";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentJob } from "@/lib/agent-jobs";
import { ACTIONS, buildAnswerModal, buildNeedsApprovalMessage } from "@/lib/slack-roadmap";
import { HOME, buildHomeView, publishHome, noticeModal } from "@/lib/slack-home";

export const maxDuration = 60;

// Fresh responses per call — a NextResponse body is single-use, so never share one instance.
const ack = () => NextResponse.json({ ok: true });
// view_submission: an empty 200 closes the modal (a JSON body would be misread by Slack).
const closeModal = () => new NextResponse(null, { status: 200 });

interface SlackUser { id: string }
interface BlockActionsPayload {
  type: "block_actions";
  user: SlackUser;
  team?: { id: string };
  channel?: { id: string };
  message?: { ts: string };
  trigger_id: string;
  actions: { action_id: string; value?: string }[];
}
interface ViewSubmissionPayload {
  type: "view_submission";
  user: SlackUser;
  team?: { id: string };
  view: {
    callback_id: string;
    private_metadata: string;
    state: { values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> };
  };
}

function parseValue(v?: string): Record<string, unknown> {
  if (!v) return {};
  try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; }
}

async function loadJob(workspaceId: string, jobId: string): Promise<AgentJob | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("agent_jobs").select("*").eq("id", jobId).eq("workspace_id", workspaceId).maybeSingle();
  return (data as AgentJob) ?? null;
}

export async function POST(request: Request) {
  const raw = await request.text();
  const sig = request.headers.get("x-slack-signature");
  const ts = request.headers.get("x-slack-request-timestamp");
  if (!verifySlackSignature(raw, sig, ts)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const payloadStr = new URLSearchParams(raw).get("payload");
  if (!payloadStr) return ack();
  const payload = JSON.parse(payloadStr) as BlockActionsPayload | ViewSubmissionPayload;

  const teamId = payload.team?.id || "";
  const workspaceId = await resolveWorkspaceByTeamId(teamId);
  if (!workspaceId) return ack();
  const token = await getSlackToken(workspaceId);
  if (!token) return ack();

  if (payload.type === "view_submission") return handleViewSubmission(payload, workspaceId, token);
  if (payload.type === "block_actions") return handleBlockActions(payload, workspaceId, token);
  return ack();
}

// ── block_actions ──

async function handleBlockActions(p: BlockActionsPayload, workspaceId: string, token: string) {
  const action = p.actions?.[0];
  if (!action) return ack();
  const value = parseValue(action.value);
  const channel = p.channel?.id;
  const messageTs = p.message?.ts;
  const slackUserId = p.user.id;

  // URL buttons (View PR / dashboard links / Home "Open") need no server work.
  if (action.action_id === ACTIONS.viewPr || action.action_id.startsWith(HOME.open)) return ack();

  // App Home tab build buttons — these carry no `channel`, so feedback is a modal, not an ephemeral.
  if (action.action_id.startsWith(HOME.build) || action.action_id.startsWith(HOME.buildPhase)) {
    return handleHomeBuild(p, action.action_id, value, workspaceId, token);
  }

  const ephem = async (msg: string) => {
    if (channel) await postEphemeral(token, channel, slackUserId, [], msg);
    return ack();
  };

  const actor = await resolveSlackActor(workspaceId, slackUserId);
  if (!isOwner(actor)) return ephem("Owner-only — that action is reserved for the workspace owner.");
  const userId = actor!.userId;

  switch (action.action_id) {
    case ACTIONS.answerOpen: {
      const jobId = String(value.jobId || "");
      const job = jobId ? await loadJob(workspaceId, jobId) : null;
      if (!job) return ephem("That build is no longer waiting on input.");
      if (job.status !== "needs_input") return ephem(`That build is now \`${job.status}\` — nothing to answer.`);
      const view = buildAnswerModal(job, job.spec_slug, { channel, ts: messageTs });
      await openModal(token, p.trigger_id, view);
      return ack();
    }

    case ACTIONS.build: {
      const slug = String(value.slug || "");
      const result = await queueRoadmapBuild(workspaceId, userId, { slug });
      if (!result.ok) return ephem(`Couldn't queue \`${slug}\`: ${result.error}`);
      const msg = result.alreadyActive
        ? `\`${slug}\` already has an active build (${result.job.status}). One build per spec.`
        : `🛠️ Queued a build for \`${slug}\`.`;
      return ephem(msg);
    }

    case ACTIONS.approve:
    case ACTIONS.decline: {
      const jobId = String(value.jobId || "");
      const actionId = String(value.actionId || "");
      const decision = action.action_id === ACTIONS.approve ? "approve" : "decline";
      const result = await approveRoadmapAction(workspaceId, userId, { jobId, actionId, decision });
      if (!result.ok) return ephem(`Couldn't record decision: ${result.error}`);
      // Approve/decline buttons only ever live on a single-purpose message → safe to update in place.
      if (channel && messageTs) {
        const rebuilt = buildNeedsApprovalMessage(result.job.spec_slug, null, result.job);
        await updateMessage(token, channel, messageTs, rebuilt.blocks, rebuilt.text);
      }
      return ack();
    }

    case ACTIONS.merge: {
      const prNumber = Number(value.prNumber || 0);
      const slug = String(value.slug || "");
      const fromMessage = value.m === 1;
      const result = await mergeClaudePr(workspaceId, userId, prNumber);
      if (!result.ok) return ephem(`Merge failed: ${result.error}`);
      // Only update a single-purpose completed message; never overwrite the shared board message.
      if (fromMessage && channel && messageTs) {
        const blocks = [
          { type: "section", text: { type: "mrkdwn", text: `🎉 *Merged* \`${slug}\` (PR #${prNumber}).` } },
        ];
        await updateMessage(token, channel, messageTs, blocks, `Merged ${slug}`);
      } else {
        await ephem(`🎉 Merged \`${slug}\` (PR #${prNumber}).`);
      }
      return ack();
    }

    default:
      return ack();
  }
}

// ── App Home build buttons (Build all / Build N) ──

/**
 * Queue a build (whole spec or one phase) from the App Home tab, then re-publish the Home view so the
 * status chip flips to "queued/building" immediately. Owner-gated (UX) here; roadmap-actions re-checks
 * server-side. Home interactions have no channel → we surface non-owner / error states via a modal.
 */
async function handleHomeBuild(
  p: BlockActionsPayload,
  actionId: string,
  value: Record<string, unknown>,
  workspaceId: string,
  token: string,
) {
  const slackUserId = p.user.id;
  const actor = await resolveSlackActor(workspaceId, slackUserId);
  if (!isOwner(actor)) {
    await openModal(token, p.trigger_id, noticeModal("Owners only", "Building is reserved for the workspace owner. You can view the roadmap, but not start builds."));
    return ack();
  }

  // slug (+ optional phase) is encoded in both the action_id and the button value; value wins for the title.
  const isPhase = actionId.startsWith(HOME.buildPhase);
  const slug = String(value.slug || (isPhase ? actionId.slice(HOME.buildPhase.length).replace(/:\d+$/, "") : actionId.slice(HOME.build.length)));
  let instructions: string | null = null;
  if (isPhase) {
    const n = Number(value.n) || Number(actionId.slice(HOME.buildPhase.length).match(/:(\d+)$/)?.[1]) || 0;
    const phaseTitle = String(value.phaseTitle || `Phase ${n}`);
    instructions = `Build only ${phaseTitle} of this spec — do ONLY that phase, not the whole spec.`;
  }

  const result = await queueRoadmapBuild(workspaceId, actor!.userId, { slug, instructions });
  if (!result.ok) {
    await openModal(token, p.trigger_id, noticeModal("Couldn't build", `Couldn't queue \`${slug}\`: ${result.error}`));
    return ack();
  }

  // Re-publish the Home view so the row reflects the new (queued / already-active) state right away.
  const view = await buildHomeView(workspaceId);
  await publishHome(token, slackUserId, view);
  return ack();
}

// ── view_submission (answer modal) ──

async function handleViewSubmission(p: ViewSubmissionPayload, workspaceId: string, token: string) {
  if (p.view.callback_id !== ACTIONS.answerSubmit) return ack();
  const meta = parseValue(p.view.private_metadata) as { jobId?: string; slug?: string; channel?: string; ts?: string };
  const jobId = String(meta.jobId || "");

  const actor = await resolveSlackActor(workspaceId, p.user.id);
  if (!isOwner(actor)) {
    const firstBlock = Object.keys(p.view.state.values)[0] || "no_questions";
    return NextResponse.json({ response_action: "errors", errors: { [firstBlock]: "Owner-only." } });
  }

  // Each input block_id is the question id; element action_id is "answer" (text or select).
  const answers: { id: string; answer: string }[] = [];
  for (const [blockId, byAction] of Object.entries(p.view.state.values)) {
    const field = byAction.answer;
    const val = field?.value ?? field?.selected_option?.value ?? "";
    answers.push({ id: blockId, answer: val });
  }

  const result = await answerRoadmapBuild(workspaceId, actor!.userId, { jobId, answers });
  if (!result.ok) {
    const firstBlock = Object.keys(p.view.state.values)[0] || "no_questions";
    return NextResponse.json({ response_action: "errors", errors: { [firstBlock]: result.error } });
  }

  // Reflect the resume on the originating message, if we know it.
  if (meta.channel && meta.ts) {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: `✅ Answered \`${meta.slug || result.job.spec_slug}\` — resuming the build.` } }];
    await updateMessage(token, meta.channel, meta.ts, blocks, "Answered — resuming");
  }
  return closeModal();
}
