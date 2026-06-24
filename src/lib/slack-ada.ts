/**
 * slack-ada — Block Kit for Ada's #cto-ada approval cards (ada-slack-chat Phase 5/6).
 *
 * ONE source of truth for the approve/reject card so the surface that POSTS it (the box worker, after a
 * coach turn) and the surfaces that RESOLVE it (the Slack interactions route on a button tap, and the web
 * coach route on a web-side decision) render identically. The card mirrors a `director_coach_threads`
 * pending_action — same shape the web coach chat approves — so Slack adds no new approval semantics.
 */

/** A pending_action as carried on a director_coach_thread (the executable card the CEO approves). */
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
