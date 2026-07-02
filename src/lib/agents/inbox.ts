/**
 * Agent inbox shell config (agents-hub-role-inboxes spec, Phase 3).
 *
 * The three-tab inbox shell every role gets: Messages · Approval Requests · Daily
 * Summaries. This file is the CLIENT-SAFE config (tab defs + the reserved
 * dashboard_notifications `type` → tab mapping) so the page and the API agree on the
 * taxonomy without either re-deriving it.
 *
 * Backing store: [[dashboard_notifications]] (it already has type/title/body/link/
 * read/dismissed) — no new table for the shell. M1 reserves the `agent_*` namespace
 * so M2/M3/M4 have a real target to emit into:
 *   - `agent_approval_request` → Approval Requests (M2: the routed approval queue)
 *   - `agent_message`          → Messages (M3: the gamified #directors board posts)
 *   - `agent_daily_summary`    → Daily Summaries (M3/M4: the EOD recap standup)
 *
 * M1 ships the shell + filters + empty/loading states ONLY; the CEO inbox is wired
 * live first (queries these types) so M2 can emit into it. No routing logic here.
 * See docs/brain/dashboard/agents.md.
 */

export type InboxTab = "messages" | "approvals" | "summaries";

export interface InboxTabDef {
  id: InboxTab;
  label: string;
  /** the reserved notification type that fills this tab */
  notificationType: string;
  /** empty-state copy (which later milestone populates it) */
  emptyHint: string;
}

export const INBOX_TABS: InboxTabDef[] = [
  {
    id: "messages",
    label: "Messages",
    notificationType: "agent_message",
    emptyHint: "The #directors board posts here once the gamified board ships (M3).",
  },
  {
    id: "approvals",
    label: "Approval Requests",
    notificationType: "agent_approval_request",
    emptyHint: "Routed approvals land here once the approval-routing engine ships (M2).",
  },
  {
    id: "summaries",
    label: "Daily Summaries",
    notificationType: "agent_daily_summary",
    emptyHint: "EOD recaps land here once the board + live director ship (M3/M4).",
  },
];

/** Every reserved type the agent inbox owns — the scope of the CEO inbox query (keeps the generic bell's notifications out). */
export const AGENT_INBOX_TYPES = INBOX_TABS.map((t) => t.notificationType);

/**
 * The reserved `dashboard_notifications.type` the approval-routing engine (M2) emits a routed
 * Approval Request under. Shared by the emitter (src/lib/agents/approval-inbox.ts) and the inbox
 * API so the type string is declared once.
 */
export const APPROVAL_REQUEST_TYPE = "agent_approval_request";

/**
 * The reserved `dashboard_notifications.type` the EOD recap (M3 Phase 4) emits a Daily Summary under.
 * Shared by the emitter (src/lib/agents/director-recap.ts) and the inbox taxonomy so it's declared once.
 */
export const DAILY_SUMMARY_TYPE = "agent_daily_summary";

/** Map a dashboard_notifications `type` to its inbox tab (null if it isn't an agent-inbox type). */
export function tabForType(type: string): InboxTab | null {
  return INBOX_TABS.find((t) => t.notificationType === type)?.id ?? null;
}

/**
 * Deep-link to a role's routed Approval Requests inbox on the Agents hub — the SINGLE place an
 * approval is surfaced + (for plain approve/decline) decided (approval-routing-engine Phase 4).
 * Every migrated surface (box page, spec cards, Control Tower feeds) points here instead of raising
 * its own standalone approval card. Defaults to the CEO inbox — the fail-safe root every approval
 * routes to until a director is live+autonomous. See docs/brain/dashboard/agents.md.
 */
export function routedInboxHref(role: string = "ceo"): string {
  return `/dashboard/agents?view=inbox&role=${encodeURIComponent(role)}`;
}

/**
 * One pending action the inbox can decide INLINE with a plain Approve/Decline (approval-routing-engine
 * Phase 4 — multi-action/multi-branch inline). A job whose pending actions are ALL plain approve/decline
 * (build gated actions, plan-proposed spec branches, repair/db-health build) surfaces every one of these
 * so the whole decision is made in the inbox. A job with ANY multi-CHOICE action (coverage register/exempt,
 * hero reject-with-notes) carries no `actions` and falls back to the `deepLink` canonical surface instead —
 * the inbox never guesses a register/exempt/preview decision.
 */
export interface InboxApprovalAction {
  id: string;
  summary: string;
  preview?: string | null;
  cmd?: string | null;
  /** set for a plan-proposed spec branch (type:'spec') — the DRI function + parent milestone. */
  specOwner?: string | null;
  specParent?: string | null;
  /**
   * out-of-leash-approval-show-exact-cmd — true on a `ceo-authorized-out-of-leash` pending action.
   * The CEO approval card renders `$ ${cmd}` in addition to `preview` (not fallback) so the literal
   * command runCeoAuthorizedOutOfLeashJob will execute is always visible, never just Ada's narrative.
   */
  outOfLeash?: boolean | null;
}

export interface InboxItem {
  id: string;
  tab: InboxTab;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
  // ── approval-routing-engine (M2) — only set on `agent_approval_request` items ──
  /** the agent_jobs row this approval request gates (drives inline Approve/Decline). */
  jobId?: string;
  /**
   * the single pending action id inline Approve/Decline acts on via POST /api/roadmap/approve.
   * Back-compat single-action pointer; `actions` (Phase 4) is the general list. null when the job is
   * multi-choice (coverage register/exempt, hero preview) — the row falls back to `deepLink`.
   */
  approveActionId?: string | null;
  /**
   * every pending plain action this approval gates, each decided INLINE with its own Approve/Decline
   * (approval-routing-engine Phase 4). Present for plain/multi-action/multi-branch jobs (build, plan,
   * repair, db-health); absent/empty for multi-CHOICE jobs, which use `deepLink` instead.
   */
  actions?: InboxApprovalAction[];
  /** canonical surface to decide a multi-CHOICE action (coverage register/exempt, hero preview). */
  deepLink?: string | null;
  /** the org-chart function this request routed to (eyeball/audit; CEO by default). */
  routedTo?: string;
  // ── bounce-escalation-back-to-director — only set on a director-escalation in the CEO inbox ──
  /** the director (function slug) that escalated this card to the CEO inbox — drives "Send back to {Director}". */
  escalatedBy?: string | null;
  /** the originating judgment lane (groom / init / repair-dismissal / approval) — null when not bounceable. */
  bounceLane?: "groom" | "init" | "repair-dismissal" | "approval" | null;
  /** the round-trip counter stamped by the worker on a re-escalation card. ≥1 hides Send-back (cap=1). */
  bouncedBackDepth?: number;
}

export interface InboxPayload {
  /** the role this inbox belongs to ("ceo" or a function slug) */
  role: string;
  /** true when this role is NOT live → its items route up to the CEO inbox (M1: always true for directors) */
  routesToCeo: boolean;
  items: InboxItem[];
}
