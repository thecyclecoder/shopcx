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

/** A pending_action as carried on a director_coach_thread (the executable card the CEO approves). */
export interface AdaCardAction {
  id: string;
  type: string; // coaching | spec | spec-edit | spec-status | goal | directive | model_tier
  summary: string;
  guidance?: string;
  // spec-status (ada-director-spec-status-cards) — when present, the card body shows a compact diff line
  // built from these proposed flips + the current state passed in by the caller.
  slug?: string;
  proposedStatus?: "planned" | "in_progress" | "shipped" | "rejected";
  phases?: { index: number; status: "planned" | "in_progress" | "shipped" | "rejected" }[];
  critical?: boolean;
  deferred?: boolean;
  reason?: string;
  // set after the card is posted to Slack, so a later chat.update can resolve it in place
  slackTs?: string;
}

/** Current state for a spec-status card's slug — same shape the web inbox renders, fetched at post-time. */
export interface AdaSpecStatusCurrent {
  status?: "planned" | "in_progress" | "shipped" | "rejected" | "deferred";
  phaseStates?: { index: number; title: string; status: "planned" | "in_progress" | "shipped" | "rejected" }[];
  critical?: boolean;
  deferred?: boolean;
}

/** action_ids for the card buttons — matched in the interactions route. */
export const ADA_ACTIONS = { approve: "ada_approve", reject: "ada_reject" } as const;

const TYPE_LABEL: Record<string, string> = {
  coaching: "Coaching rule",
  spec: "New spec",
  "spec-edit": "Spec edit",
  "spec-status": "Spec status flip",
  goal: "Proposed goal",
  directive: "Plan / directive",
  model_tier: "Model-tier change",
};

/** Compact current→proposed lines for a spec-status card (Slack mrkdwn; ada-director-spec-status-cards P3). */
function specStatusDiffLines(a: AdaCardAction, current: AdaSpecStatusCurrent | undefined): string[] {
  const lines: string[] = [];
  if (a.proposedStatus) lines.push(`• status: \`${current?.status ?? "—"}\` → *${a.proposedStatus}*`);
  for (const p of a.phases ?? []) {
    const prior = current?.phaseStates?.find((s) => s.index === p.index);
    const tail = prior?.title ? ` — ${prior.title}` : "";
    lines.push(`• phase #${p.index + 1}${tail}: \`${prior?.status ?? "—"}\` → *${p.status}*`);
  }
  if (typeof a.critical === "boolean") lines.push(`• critical: \`${current ? String(!!current.critical) : "—"}\` → *${a.critical}*`);
  if (typeof a.deferred === "boolean") lines.push(`• deferred: \`${current ? String(!!current.deferred) : "—"}\` → *${a.deferred}*`);
  return lines;
}

function detail(a: AdaCardAction, current?: AdaSpecStatusCurrent): string {
  const label = TYPE_LABEL[a.type] || a.type;
  let body = a.guidance ? `\n${a.guidance}` : "";
  if (a.type === "spec-status" && a.slug) {
    const diff = specStatusDiffLines(a, current);
    const slugLine = `\n_⇄ spec_card_state[${a.slug}] · DB-only flip (no markdown commit)_`;
    body = `${slugLine}${diff.length ? "\n" + diff.join("\n") : ""}${a.reason ? `\n_because — ${a.reason}_` : ""}`;
  }
  return `*${label}* — ${a.summary}${body}`;
}

/** The pending approval card (section + Approve/Reject buttons). `value` carries the routing for the tap.
 *  Pass `specStatusCurrent` for a `spec-status` card so the body shows current→proposed for each field. */
export function buildAdaApprovalCard(threadId: string, a: AdaCardAction, specStatusCurrent?: AdaSpecStatusCurrent): { blocks: unknown[]; text: string } {
  const value = JSON.stringify({ thread_id: threadId, actionId: a.id });
  return {
    text: `Approval needed: ${a.summary}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: detail(a, specStatusCurrent) } },
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
export function buildAdaResolvedCard(a: AdaCardAction, decision: "approve" | "decline", specStatusCurrent?: AdaSpecStatusCurrent): { blocks: unknown[]; text: string } {
  const tail = decision === "approve" ? "✅ Approved — applying…" : "✕ Declined";
  return {
    text: `${a.summary} — ${tail}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `${detail(a, specStatusCurrent)}\n\n${tail}` } }],
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

/** One still-pending plain action the inbox card surfaces a row of Approve/Reject buttons for. */
export interface InboxCardAction {
  id: string;
  summary: string;
}

/**
 * Build the routed-inbox approval card (ada-slack-routed-approvals Phase 1). Title, the agent's
 * investigation body (same content the web inbox shows inline), and ONE row of Approve/Reject buttons
 * per still-pending plain action. Caller passes the `notificationId` (the freshly inserted
 * `dashboard_notifications.id`) so each button's `value` JSON carries `{ notificationId, actionId }`
 * — enough for the interactions route to look up the row + call `approveRoadmapAction` (Phase 2).
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
    const value = JSON.stringify({ notificationId, actionId: a.id });
    blocks.push({
      type: "actions",
      block_id: `inbox_${a.id}`.slice(0, 255),
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: INBOX_ACTIONS.approve, value },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: INBOX_ACTIONS.reject, value },
      ],
    });
  }
  return { blocks, text: `Approval needed: ${title}` };
}
