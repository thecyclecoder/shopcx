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
  updateModal,
} from "@/lib/slack";
import { resolveSlackActor, isOwner } from "@/lib/slack-identity";
import { queueRoadmapBuild, approveRoadmapAction, mergeClaudePr, answerRoadmapBuild } from "@/lib/roadmap-actions";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSpec } from "@/lib/brain-roadmap";
import { getLatestJobsBySlug, getPendingFolds, type AgentJob } from "@/lib/agent-jobs";
import { ACTIONS, buildAnswerModal, buildNeedsApprovalMessage } from "@/lib/slack-roadmap";
import { HOME, buildHomeView, publishHome, noticeModal, buildSpecModal, buildSpecConfirmModal } from "@/lib/slack-home";
import { setActionDecision } from "@/lib/agents/director-coach-threads";
import { ADA_ACTIONS, INBOX_ACTIONS, buildAdaResolvedCard, buildInboxApprovalCard, type InboxCardAction } from "@/lib/slack-ada";
import type { PendingAction } from "@/lib/agent-jobs";

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
  view?: { id?: string }; // set when the action fired from inside a modal (so we can views.update it)
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

  // App Home: tapping a spec's Details opens the in-Slack detail modal (anyone may view; the build/
  // verify actions inside it are owner-gated). Uses the block_actions trigger_id to views.open.
  if (action.action_id.startsWith(HOME.details)) {
    return handleHomeDetails(p, action.action_id, value, workspaceId, token);
  }

  // App Home build / per-phase / verify buttons (Home row OR inside the modal) — these carry no
  // `channel`, so feedback is a modal, not an ephemeral.
  if (
    action.action_id.startsWith(HOME.build) ||
    action.action_id.startsWith(HOME.buildPhase) ||
    action.action_id.startsWith(HOME.verify)
  ) {
    return handleHomeBuild(p, action.action_id, value, workspaceId, token);
  }

  const ephem = async (msg: string) => {
    if (channel) await postEphemeral(token, channel, slackUserId, [], msg);
    return ack();
  };

  const actor = await resolveSlackActor(workspaceId, slackUserId);
  if (!isOwner(actor)) return ephem("Owner-only — that action is reserved for the workspace owner.");
  const userId = actor!.userId;

  // ada-slack-chat: Approve / Reject on one of Ada's #cto-ada coaching cards. Same path the web coach chat
  // uses (setActionDecision → enqueue approve_action); resolve the card in place so it's not re-clickable.
  if (action.action_id === ADA_ACTIONS.approve || action.action_id === ADA_ACTIONS.reject) {
    return handleAdaDecision(action.action_id, value, channel, messageTs, workspaceId, userId, token, ephem);
  }

  // ada-slack-routed-approvals: Approve / Reject on one of Ada's routed CEO-inbox cards (Phase 2).
  // Dispatches plain approve/decline through `approveRoadmapAction` — the SAME function the web inbox
  // calls, so the leash, bundle ALL-OR-NOTHING rule, and every safety invariant are inherited unchanged.
  if (action.action_id === INBOX_ACTIONS.approve || action.action_id === INBOX_ACTIONS.reject) {
    return handleInboxDecision(action.action_id, value, channel, messageTs, workspaceId, userId, token, ephem);
  }

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

// ── ada-slack-chat: resolve an #cto-ada approval card ──

/**
 * Approve / Reject a director-coach pending_action from #cto-ada. Records the decision via the SAME
 * setActionDecision the web coach chat uses, then (on approve) enqueues the identical `approve_action`
 * job the box executes — no Slack-only mutation path. The card is rebuilt without buttons so it reads as
 * resolved and can't be tapped twice (setActionDecision only flips a still-`pending` card, so re-taps no-op).
 */
async function handleAdaDecision(
  actionId: string,
  value: Record<string, unknown>,
  channel: string | undefined,
  messageTs: string | undefined,
  workspaceId: string,
  userId: string,
  token: string,
  ephem: (msg: string) => Promise<NextResponse>,
) {
  const decision = actionId === ADA_ACTIONS.approve ? "approve" : "decline";
  const threadId = String(value.thread_id || "");
  const cardId = String(value.actionId || "");
  if (!threadId || !cardId) return ack();

  const thread = await setActionDecision(workspaceId, threadId, cardId, decision);
  if (!thread) return ephem("That conversation is no longer available.");

  // Resolve the card in place (drop the buttons → "✅ Approved — applying…" / "✕ Declined").
  const card = thread.pending_actions.find((a) => a.id === cardId);
  if (card && channel && messageTs) {
    // ada-director-spec-status-cards Phase 3: keep the diff visible on the resolved render too.
    let current: Parameters<typeof buildAdaResolvedCard>[2] | undefined;
    if (card.type === "spec-status" && card.slug) {
      const { getSpecCardStates, effectiveStatusFromState } = await import("@/lib/spec-card-state");
      const states = await getSpecCardStates(workspaceId);
      const s = states[card.slug];
      current = {
        status: effectiveStatusFromState(s),
        phaseStates: s?.phase_states ?? [],
        critical: !!s?.flags?.critical,
        deferred: !!s?.flags?.deferred,
      };
    }
    const rebuilt = buildAdaResolvedCard(
      {
        id: card.id,
        type: card.type,
        summary: card.summary,
        guidance: card.guidance,
        slug: card.slug,
        proposedStatus: card.proposedStatus,
        phases: card.phases,
        critical: card.critical,
        deferred: card.deferred,
        reason: card.reason,
      },
      decision,
      current,
    );
    await updateMessage(token, channel, messageTs, rebuilt.blocks, rebuilt.text);
  }

  // Approve → run the action through the exact same box path the dashboard uses.
  if (decision === "approve") {
    const admin = createAdminClient();
    await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      kind: "director-coach",
      spec_slug: threadId,
      status: "queued",
      instructions: JSON.stringify({ thread_id: threadId, mode: "approve_action" }),
      created_by: userId,
    });
  }
  return ack();
}

// ── ada-slack-routed-approvals: resolve a routed CEO-inbox card (Phase 2) ──

/**
 * Approve / Reject a routed CEO-inbox card posted in #cto-ada. Looks up the
 * `dashboard_notifications` row by its id (carried in the button value), reads `metadata.agent_job_id`
 * for the underlying `agent_jobs` row, and dispatches through `approveRoadmapAction` — the SAME
 * function the web inbox's `/api/roadmap/approve` route calls, so the leash, bundle ALL-OR-NOTHING
 * rule, escalation, and ledger are inherited (no new mutation path). The card is then `chat.update`d
 * from the updated job state so a multi-action bundle keeps still-pending rows tappable while the
 * just-tapped row flips to its resolved label. The one-line outcome confirmation in the thread is
 * posted later by `reconcileApprovalInbox`'s dismiss pass when the job leaves `needs_approval`.
 */
async function handleInboxDecision(
  actionId: string,
  value: Record<string, unknown>,
  channel: string | undefined,
  messageTs: string | undefined,
  workspaceId: string,
  userId: string,
  token: string,
  ephem: (msg: string) => Promise<NextResponse>,
) {
  const decision = actionId === INBOX_ACTIONS.approve ? "approve" : "decline";
  const notificationId = String(value.notificationId || "");
  const actId = String(value.actionId || "");
  if (!notificationId || !actId) return ack();

  const admin = createAdminClient();
  const { data: notif } = await admin
    .from("dashboard_notifications")
    .select("id, workspace_id, title, body, metadata")
    .eq("id", notificationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!notif) return ephem("That approval is no longer available.");
  const meta = (notif.metadata || {}) as Record<string, unknown>;
  const jobId = typeof meta.agent_job_id === "string" ? meta.agent_job_id : "";
  if (!jobId) return ephem("That approval is missing job context.");

  const result = await approveRoadmapAction(workspaceId, userId, {
    jobId,
    actionId: actId,
    decision,
    // ada-slack-routed-approvals Phase 4: tag this call so the web→Slack mirror is skipped — we
    // already chat.update the card a few lines down (without the "(in web inbox)" suffix), and
    // mirroring would double-update it with the wrong label for a Slack-side decision.
    source: "slack-inbox",
  });
  if (!result.ok) return ephem(`Couldn't record decision: ${result.error}`);

  // Rebuild the card from the updated job state so a multi-action bundle keeps tappable rows for the
  // remaining pending actions while the just-tapped row flips to its resolved label. `chat.update`
  // keys on the stored ts — Phase 1's idempotent stash (`metadata.slack_message_ts`) makes this match.
  if (channel && messageTs) {
    const job = result.job;
    const cardActions: InboxCardAction[] = (job.pending_actions || [])
      .filter((a): a is PendingAction => !!a.id)
      .map((a) => ({
        id: a.id,
        summary: a.summary ?? "",
        status: a.status === "approved" ? "approved" : a.status === "declined" ? "declined" : "pending",
      }));
    const rebuilt = buildInboxApprovalCard({
      notificationId,
      title: notif.title ?? "",
      body: notif.body ?? "",
      actions: cardActions,
    });
    await updateMessage(token, channel, messageTs, rebuilt.blocks, rebuilt.text);
  }
  return ack();
}

// ── App Home: open the spec-detail modal ──

/**
 * Open the in-Slack spec-detail modal for a tapped spec row (slack-home-detail Phase 2). Anyone may
 * view it (read-only review); the build/verify buttons inside are rendered only for the owner and
 * re-checked server-side. Rebuilt from getSpec() so it never drifts from the brain.
 */
async function handleHomeDetails(
  p: BlockActionsPayload,
  actionId: string,
  value: Record<string, unknown>,
  workspaceId: string,
  token: string,
) {
  const slug = String(value.slug || actionId.slice(HOME.details.length));
  const found = await getSpec(slug);
  if (!found) {
    await openModal(token, p.trigger_id, noticeModal("Not found", `No spec \`${slug}\` — it may have been archived.`));
    return ack();
  }
  const [jobs, folds, actor] = await Promise.all([
    getLatestJobsBySlug(workspaceId),
    getPendingFolds(workspaceId),
    resolveSlackActor(workspaceId, p.user.id),
  ]);
  const view = buildSpecModal(found.card, found.raw, jobs[slug] ?? null, folds[slug] ?? null, isOwner(actor));
  await openModal(token, p.trigger_id, view);
  return ack();
}

// ── App Home build / verify buttons (Build all / Build N / Mark verified & archive) ──

/**
 * Queue a build (whole spec or one phase) or a verify-and-fold from the App Home tab — from a row OR
 * from inside the spec-detail modal. Owner-gated (UX) here; roadmap-actions re-checks server-side.
 * Home interactions have no channel, so feedback is a modal (a fresh notice, or an in-place update of
 * the modal the action fired from). Always re-publishes the Home view so the row chip flips at once.
 */
async function handleHomeBuild(
  p: BlockActionsPayload,
  actionId: string,
  value: Record<string, unknown>,
  workspaceId: string,
  token: string,
) {
  const slackUserId = p.user.id;
  const fromModal = !!p.view?.id;
  // Feedback goes in-place when the action came from the modal, else as a fresh notice modal.
  const notice = async (title: string, text: string) => {
    if (fromModal) await updateModal(token, p.view!.id!, buildSpecConfirmModal(title, text));
    else await openModal(token, p.trigger_id, noticeModal(title, text));
    return ack();
  };

  const actor = await resolveSlackActor(workspaceId, slackUserId);
  if (!isOwner(actor)) {
    return notice("Owners only", "Building is reserved for the workspace owner. You can review the roadmap, but not start builds.");
  }

  const isVerify = actionId.startsWith(HOME.verify);
  const isPhase = actionId.startsWith(HOME.buildPhase);

  if (isVerify) {
    const slug = String(value.slug || actionId.slice(HOME.verify.length));
    const result = await queueRoadmapBuild(workspaceId, actor!.userId, { slug, verify: true });
    if (!result.ok) return notice("Couldn't verify", `Couldn't queue the fold-build for \`${slug}\`: ${result.error}`);
    await republishHome(workspaceId, token, slackUserId);
    return notice("Verified", `✅ Marked \`${slug}\` verified — queued a fold-build to archive it into the brain.`);
  }

  // slug (+ optional phase) is encoded in both the action_id and the button value; value wins for the title.
  const slug = String(value.slug || (isPhase ? actionId.slice(HOME.buildPhase.length).replace(/:\d+$/, "") : actionId.slice(HOME.build.length)));
  let instructions: string | null = null;
  if (isPhase) {
    const n = Number(value.n) || Number(actionId.slice(HOME.buildPhase.length).match(/:(\d+)$/)?.[1]) || 0;
    const phaseTitle = String(value.phaseTitle || `Phase ${n}`);
    instructions = `Build only ${phaseTitle} of this spec — do ONLY that phase, not the whole spec.`;
  }

  // The "Build all" button (non-phase) chains the phases (build-all-phases-chain): queue the first ⏳
  // phase tagged chain_phases so each subsequent phase auto-queues on merge until all ✅. A per-phase
  // "Build N" stays a single scoped build (no chain).
  const result = await queueRoadmapBuild(workspaceId, actor!.userId, { slug, instructions, chainPhases: !isPhase });
  if (!result.ok) return notice("Couldn't build", `Couldn't queue \`${slug}\`: ${result.error}`);

  await republishHome(workspaceId, token, slackUserId);
  const msg = result.queuedBehindActive
    ? `\`${slug}\` already has an active build — queued your scoped fix as build \`${result.job.id.slice(0, 8)}\` to run next (nothing dropped).`
    : result.alreadyActive
      ? `\`${slug}\` already has an active build (${result.job.status}). One build per spec.`
      : `🛠️ Queued a build for \`${slug}\`.`;
  const title = result.queuedBehindActive ? "Queued behind active" : result.alreadyActive ? "Already building" : "Queued";
  return notice(title, msg);
}

/** Re-publish the Home view so a row's status chip reflects a just-queued build/verify immediately. */
async function republishHome(workspaceId: string, token: string, slackUserId: string): Promise<void> {
  const view = await buildHomeView(workspaceId);
  await publishHome(token, slackUserId, view);
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
