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
   * null when the job is multi-action or multi-choice (coverage register/exempt, hero preview) —
   * the row falls back to the `deepLink` surface so the richer decision isn't guessed at.
   */
  approveActionId?: string | null;
  /** canonical surface to decide a richer/multi-choice action (Phase 4 folds these into the inbox). */
  deepLink?: string | null;
  /** the org-chart function this request routed to (eyeball/audit; CEO by default). */
  routedTo?: string;
}

export interface InboxPayload {
  /** the role this inbox belongs to ("ceo" or a function slug) */
  role: string;
  /** true when this role is NOT live → its items route up to the CEO inbox (M1: always true for directors) */
  routesToCeo: boolean;
  items: InboxItem[];
}
