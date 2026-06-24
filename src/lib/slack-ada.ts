/**
 * slack-ada — Block Kit for Ada's #cto-ada approval cards (ada-slack-chat Phase 5/6).
 *
 * ONE source of truth for the approve/reject card so the surface that POSTS it (the box worker, after a
 * coach turn) and the surfaces that RESOLVE it (the Slack interactions route on a button tap, and the web
 * coach route on a web-side decision) render identically. The card mirrors a `director_coach_threads`
 * pending_action — same shape the web coach chat approves — so Slack adds no new approval semantics.
 *
 * Also hosts the *routed-inbox* approval card (ada-slack-routed-approvals Phase 1) — a distinct surface
 * from the coach-chat card above. The routed inbox emit mirrors a `dashboard_notifications` row gating an
 * `agent_jobs` `needs_approval` instead of a coach-thread pending_action, so it carries its own button
 * `action_id`s (`inbox_approve`/`inbox_reject`) and a `{ notificationId, actionId }` value — the
 * interactions route dispatches plain approve/decline through `approveRoadmapAction`, same path the web
 * inbox uses.
 */

/** A pending_action as carried on a director_coach_thread (the executable card the CEO approves).
 *  Note: `spec-status` is NOT in this set — it's auto-applied and never reaches an approval card
 *  ([[../specs/ada-director-spec-status-cards]] Phase 1 revised). */
export interface AdaCardAction {
  id: string;
  type: string; // coaching | spec | spec-edit | goal | directive | model_tier
  summary: string;
  guidance?: string;
  // set after the card is posted to Slack, so a later chat.update can resolve it in place
  slackTs?: string;
}

/** action_ids for the card buttons — matched in the interactions route. */
export const ADA_ACTIONS = { approve: "ada_approve", reject: "ada_reject" } as const;

const TYPE_LABEL: Record<string, string> = {
  coaching: "Coaching rule",
  spec: "New spec",
  "spec-edit": "Spec edit",
  goal: "Proposed goal",
  directive: "Plan / directive",
  model_tier: "Model-tier change",
};

function detail(a: AdaCardAction): string {
  const label = TYPE_LABEL[a.type] || a.type;
  const body = a.guidance ? `\n${a.guidance}` : "";
  return `*${label}* — ${a.summary}${body}`;
}

/** The pending approval card (section + Approve/Reject buttons). `value` carries the routing for the tap. */
export function buildAdaApprovalCard(threadId: string, a: AdaCardAction): { blocks: unknown[]; text: string } {
  const value = JSON.stringify({ thread_id: threadId, actionId: a.id });
  return {
    text: `Approval needed: ${a.summary}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: detail(a) } },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: ADA_ACTIONS.approve, value },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: ADA_ACTIONS.reject, value },
        ],
      },
    ],
  };
}

/** The resolved card (no buttons) — replaces the approval card in place once a decision is recorded. */
export function buildAdaResolvedCard(a: AdaCardAction, decision: "approve" | "decline"): { blocks: unknown[]; text: string } {
  const tail = decision === "approve" ? "✅ Approved — applying…" : "✕ Declined";
  return {
    text: `${a.summary} — ${tail}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `${detail(a)}\n\n${tail}` } }],
  };
}

// ── Routed-inbox approval card (ada-slack-routed-approvals Phase 1) ────────────────────────────────

/**
 * action_ids for the routed-inbox approval card — DISTINCT from `ADA_ACTIONS` (the coach-chat card)
 * so the Slack interactions route dispatches to the inbox decision path (Phase 2), not the coach-chat
 * pending_action handler. A button's `value` carries the `{ notificationId, actionId }` the inbox
 * decision needs to call `approveRoadmapAction`.
 */
export const INBOX_ACTIONS = { approve: "inbox_approve", reject: "inbox_reject" } as const;

/** One plain action the inbox card surfaces. Pending → Approve/Reject buttons; approved/declined →
 * a context line in place of the buttons so the same `chat.update` can resolve one action in a
 * multi-action card without removing the still-pending rows (Phase 2 — per-action resolution). */
export interface InboxCardAction {
  id: string;
  summary: string;
  status?: "pending" | "approved" | "declined";
  /**
   * Phase 4 (ada-slack-routed-approvals) — on a resolved row, swap the default label tail for
   * "(in web inbox)" so the founder can tell at a glance which surface decided this one. Set by
   * the web→Slack mirror; the in-Slack tap leaves it false so its own update reads "applying…".
   */
  decidedInWebInbox?: boolean;
}

/**
 * Build the routed-inbox approval card (ada-slack-routed-approvals Phase 1). Title, the agent's
 * investigation body (same content the web inbox shows inline), and ONE row per action — either
 * Approve/Reject buttons (`status='pending'`, the default) or a resolved context label
 * ("✅ Approved — applying…" / "✕ Declined") when the action's already been decided. Caller
 * passes the `notificationId` (the freshly inserted `dashboard_notifications.id`) so each button's
 * `value` JSON carries `{ notificationId, actionId }` — enough for the interactions route to look
 * up the row + call `approveRoadmapAction` (Phase 2).
 *
 * Phase 2 re-uses this builder to rebuild the card from the updated job state on a button tap,
 * so a multi-action bundle keeps the still-pending rows tappable while the just-tapped row flips
 * to its resolved label in place (chat.update keyed on `metadata.slack_message_ts`).
 */
export function buildInboxApprovalCard(opts: {
  notificationId: string;
  title: string;
  body: string;
  actions: InboxCardAction[];
}): { blocks: unknown[]; text: string } {
  const { notificationId, title, body, actions } = opts;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
  ];
  if (body) {
    // Slack hard-limits a section text block at 3000 chars; reserve a few for safety.
    blocks.push({ type: "section", text: { type: "mrkdwn", text: body.slice(0, 2900) } });
  }
  for (const a of actions) {
    const status = a.status ?? "pending";
    const blockId = `inbox_${a.id}`.slice(0, 255);
    if (status === "pending") {
      const value = JSON.stringify({ notificationId, actionId: a.id });
      blocks.push({
        type: "actions",
        block_id: blockId,
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: INBOX_ACTIONS.approve, value },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: INBOX_ACTIONS.reject, value },
        ],
      });
    } else {
      const tail = status === "approved"
        ? a.decidedInWebInbox ? "✅ Approved (in web inbox)" : "✅ Approved — applying…"
        : a.decidedInWebInbox ? "✕ Declined (in web inbox)" : "✕ Declined";
      const prefix = a.summary ? `${a.summary} — ` : "";
      blocks.push({
        type: "context",
        block_id: blockId,
        elements: [{ type: "mrkdwn", text: `${prefix}${tail}` }],
      });
    }
  }
  return { blocks, text: `Approval needed: ${title}` };
}
