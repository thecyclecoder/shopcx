/**
 * tickets-read — read-only SDK for pulling a ticket's full picture.
 *
 * Purpose: give tools (the `/investigate-ticket` skill, dashboards, debugging) ONE typed way to
 * read everything about a ticket — the row, its customer, its messages (with delivery state), the
 * Sol Direction artifacts, the Sol `ticket-handle` box-session jobs, merge/redirect history — WITHOUT
 * raw `.from("tickets")` queries scattered across callers (CLAUDE.md discipline: reads go through an
 * SDK, not ad-hoc DB access). All functions take an admin (`createAdminClient()`) client from the caller.
 *
 * READ-ONLY. Nothing here mutates. Merge-aware: a merged-away ticket id transparently resolves to its
 * live target via [[ticket-merge]] `resolveMergedTarget` (e.g. an archived reply-duplicate → the surviving
 * ticket), so an id from a stale link still lands on the real conversation.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMergedTarget } from "@/lib/ticket-merge";

type Admin = ReturnType<typeof createAdminClient>;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Extract a ticket UUID from a raw id OR a dashboard URL (…/dashboard/tickets/{id}). Throws if none. */
export function parseTicketRef(idOrUrl: string): string {
  const m = String(idOrUrl || "").match(UUID_RE);
  if (!m) throw new Error(`No ticket UUID found in "${idOrUrl}"`);
  return m[0].toLowerCase();
}

/** The `spec_slug` a Sol first-touch `ticket-handle` box-session job carries for a ticket. */
export function specSlugForTicketHandle(ticketId: string): string {
  return `ticket-handle-${ticketId.slice(0, 8)}`;
}

export interface TicketRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  channel: string | null;
  status: string | null;
  subject: string | null;
  tags: string[] | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  last_customer_reply_at: string | null;
  last_analyzed_at: string | null;
  active_playbook_id: string | null;
  playbook_step: number | null;
  merged_into: string | null;
  escalated_to: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  handled_by: string | null;
}

const TICKET_COLS =
  "id, workspace_id, customer_id, channel, status, subject, tags, created_at, updated_at, closed_at, " +
  "last_customer_reply_at, last_analyzed_at, active_playbook_id, playbook_step, merged_into, " +
  "escalated_to, escalated_at, escalation_reason, handled_by";

export interface CustomerLite {
  id: string;
  email: string | null;
  first_name: string | null;
}

export interface TicketMessageRow {
  id: string;
  direction: string | null;
  visibility: string | null;
  author_type: string | null;
  body: string | null;
  body_clean: string | null;
  created_at: string | null;
  ai_draft: boolean | null;
  pending_send_at: string | null;
  sent_at: string | null;
  send_cancelled: boolean | null;
  resend_email_id: string | null;
  email_status: string | null;
}

export interface TicketDirectionRow {
  id: string;
  intent: string | null;
  context_summary: string | null;
  chosen_path: string | null;
  plan: Record<string, unknown> | null;
  guardrails: Record<string, unknown> | null;
  authored_by: string | null;
  authored_at: string | null;
  superseded_at: string | null;
  resession_count: number | null;
}

export interface HandleJobRow {
  id: string;
  kind: string | null;
  status: string | null;
  error: string | null;
  session_note: string | null;
  preview_state: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** parsed from log_tail's terminal_reason when present */
  terminal_reason: string | null;
}

/** Resolve a ticket id/url to its live row (following merge redirects). */
export async function getTicket(
  admin: Admin,
  idOrUrl: string,
): Promise<{ ticket: TicketRow | null; requestedId: string; resolvedId: string; redirected: boolean }> {
  const requestedId = parseTicketRef(idOrUrl);
  const resolvedId = await resolveMergedTarget(admin, requestedId);
  const { data } = await admin.from("tickets").select(TICKET_COLS).eq("id", resolvedId).maybeSingle();
  return { ticket: (data as unknown as TicketRow) ?? null, requestedId, resolvedId, redirected: resolvedId !== requestedId };
}

export async function getCustomerLite(admin: Admin, customerId: string | null): Promise<CustomerLite | null> {
  if (!customerId) return null;
  const { data } = await admin.from("customers").select("id, email, first_name").eq("id", customerId).maybeSingle();
  return (data as CustomerLite) ?? null;
}

/** Chronological messages for a ticket (oldest first). */
export async function getTicketMessages(admin: Admin, ticketId: string): Promise<TicketMessageRow[]> {
  const { data } = await admin
    .from("ticket_messages")
    .select(
      "id, direction, visibility, author_type, body, body_clean, created_at, ai_draft, pending_send_at, sent_at, send_cancelled, resend_email_id, email_status",
    )
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  return (data as TicketMessageRow[]) ?? [];
}

/** Sol Direction artifacts for a ticket (newest first; live row is the one with superseded_at IS NULL). */
export async function getTicketDirections(admin: Admin, ticketId: string): Promise<TicketDirectionRow[]> {
  const { data } = await admin
    .from("ticket_directions")
    .select("id, intent, context_summary, chosen_path, plan, guardrails, authored_by, authored_at, superseded_at, resession_count")
    .eq("ticket_id", ticketId)
    .order("authored_at", { ascending: false });
  return (data as TicketDirectionRow[]) ?? [];
}

/** Sol first-touch `ticket-handle` box-session jobs for a ticket (newest first). */
export async function getTicketHandleJobs(admin: Admin, workspaceId: string, ticketId: string): Promise<HandleJobRow[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, kind, status, error, session_note, log_tail, preview_state, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", specSlugForTicketHandle(ticketId))
    .order("created_at", { ascending: false });
  return ((data as Array<HandleJobRow & { log_tail?: string | null }>) ?? []).map((j) => {
    let terminal_reason: string | null = null;
    const m = (j.log_tail || "").match(/"terminal_reason":"([^"]+)"/);
    if (m) terminal_reason = m[1];
    const { log_tail: _drop, ...rest } = j;
    return { ...rest, terminal_reason };
  });
}

/** Tickets that were merged INTO this one (reply-duplicates / prior threads absorbed here). */
export async function getMergedFromTickets(
  admin: Admin,
  ticketId: string,
): Promise<Array<{ id: string; subject: string | null; status: string | null; created_at: string | null }>> {
  const { data } = await admin
    .from("tickets")
    .select("id, subject, status, created_at")
    .eq("merged_into", ticketId)
    .order("created_at", { ascending: true });
  return (data as Array<{ id: string; subject: string | null; status: string | null; created_at: string | null }>) ?? [];
}

export interface TicketInvestigation {
  ref: { requested: string; resolved: string; redirected: boolean };
  ticket: TicketRow | null;
  customer: CustomerLite | null;
  messages: TicketMessageRow[];
  directions: TicketDirectionRow[];
  handleJobs: HandleJobRow[];
  mergedFrom: Array<{ id: string; subject: string | null; status: string | null; created_at: string | null }>;
}

/** Composite read: assemble a ticket's entire picture in one call (merge-aware). */
export async function investigateTicket(admin: Admin, idOrUrl: string): Promise<TicketInvestigation> {
  const { ticket, requestedId, resolvedId, redirected } = await getTicket(admin, idOrUrl);
  if (!ticket) {
    return {
      ref: { requested: requestedId, resolved: resolvedId, redirected },
      ticket: null,
      customer: null,
      messages: [],
      directions: [],
      handleJobs: [],
      mergedFrom: [],
    };
  }
  const [customer, messages, directions, handleJobs, mergedFrom] = await Promise.all([
    getCustomerLite(admin, ticket.customer_id),
    getTicketMessages(admin, ticket.id),
    getTicketDirections(admin, ticket.id),
    getTicketHandleJobs(admin, ticket.workspace_id, ticket.id),
    getMergedFromTickets(admin, ticket.id),
  ]);
  return {
    ref: { requested: requestedId, resolved: resolvedId, redirected },
    ticket,
    customer,
    messages,
    directions,
    handleJobs,
    mergedFrom,
  };
}

export interface DeliveryState {
  /** the ai message closest after the turn, and whether it actually shipped */
  reply: TicketMessageRow | null;
  sent: boolean;
  staged: boolean;
  cancelled: boolean;
}

export interface TurnDiagnosis {
  turn: number;
  customerAt: string | null;
  customerBody: string;
  /** the Direction authored for/around this turn, if any */
  direction: TicketDirectionRow | null;
  /** did the Direction's plan describe an action but no reply land? */
  firstReplyDelivered: boolean;
  planHasActionSteps: boolean;
  /** a plain-English flag when a turn ran but produced no customer-facing output */
  silentTurn: boolean;
}

const stripHtml = (s: string | null | undefined) =>
  String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Pair each customer inbound with the AI reply that followed it and flag SILENT turns — a turn where a
 * customer wrote in and either no AI reply shipped, or a Direction was authored whose plan implies an
 * action/reply that never materialised (the ticket-83ee7005 class: Direction written, nothing delivered).
 */
export function buildTurnTimeline(inv: TicketInvestigation): TurnDiagnosis[] {
  const customerMsgs = inv.messages.filter((m) => m.author_type === "customer" && m.visibility === "external");
  const aiMsgs = inv.messages.filter((m) => m.author_type === "ai" && m.visibility === "external");
  const out: TurnDiagnosis[] = [];
  customerMsgs.forEach((cm, i) => {
    const nextCustomerAt = customerMsgs[i + 1]?.created_at ?? null;
    // an AI reply "belongs" to this turn if it lands after this customer msg and before the next one
    const reply = aiMsgs.find(
      (a) => (a.created_at ?? "") > (cm.created_at ?? "") && (!nextCustomerAt || (a.created_at ?? "") < nextCustomerAt),
    );
    const sent = !!reply?.sent_at && !reply?.send_cancelled;
    // the Direction authored in this turn window
    const direction = inv.directions.find(
      (d) => (d.authored_at ?? "") > (cm.created_at ?? "") && (!nextCustomerAt || (d.authored_at ?? "") < nextCustomerAt),
    ) ?? null;
    const plan = direction?.plan ?? {};
    const planHasActionSteps =
      Array.isArray((plan as { steps?: unknown }).steps) &&
      ((plan as { steps?: unknown[] }).steps as unknown[]).length > 0;
    const firstReplyDelivered = sent;
    const silentTurn = !!direction && !sent; // a Direction was authored but no reply shipped
    out.push({
      turn: i + 1,
      customerAt: cm.created_at,
      customerBody: stripHtml(cm.body).slice(0, 200),
      direction,
      firstReplyDelivered,
      planHasActionSteps,
      silentTurn,
    });
  });
  return out;
}
