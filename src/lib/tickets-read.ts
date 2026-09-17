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
import { linkGroupIds } from "@/lib/customer-links";

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
  assigned_to: string | null;
  /** Legacy boolean the widget/live-chat re-dispatch gate reads — distinct from `ai_handled_at`. */
  ai_handled: boolean | null;
  ai_handled_at: string | null;
  sol_handled_at: string | null;
  ai_disabled: boolean | null;
  analyzer_locked: boolean | null;
  do_not_reply: boolean | null;
}

const TICKET_COLS =
  "id, workspace_id, customer_id, channel, status, subject, tags, created_at, updated_at, closed_at, " +
  "last_customer_reply_at, last_analyzed_at, active_playbook_id, playbook_step, merged_into, " +
  "escalated_to, escalated_at, escalation_reason, handled_by, " +
  // Dispatch-blocking state — an investigation must surface WHY a customer reply may not have been
  // handled: a human owns it (assigned_to), AI is off (ai_disabled), the analyzer is vetoed
  // (analyzer_locked), we deliberately don't reply (do_not_reply), or the legacy ai_handled flag the
  // widget/live-chat re-dispatch gate still reads (distinct from the harness ai_handled_at stamp).
  "assigned_to, ai_handled, ai_handled_at, sol_handled_at, ai_disabled, analyzer_locked, do_not_reply";

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

export interface LinkedSubscriptionRow {
  id: string;
  customer_id: string | null;
  status: string | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  items: Array<{ title?: string; variant_title?: string; variant_id?: string; quantity?: number; price_cents?: number }> | null;
}

export interface LinkedOrderRow {
  order_number: string | null;
  customer_id: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  total_cents: number | null;
  created_at: string | null;
  delivery_status: string | null;
  delivered_at: string | null;
  amplifier_status: string | null;
  amplifier_tracking_number: string | null;
  line_items: Array<{ title?: string; variant_title?: string; quantity?: number }> | null;
  /**
   * a-flagged-allergen-order-must-not-ship Phase 2 — the raise-time protective hold state. Three
   * distinguishable values ('placed' | 'refused' | null) MUST render on every surface that shows
   * this order (founder queue, director's investigate context, handling-agent context) so a false
   * "we're stopping it" reassurance cannot be sent while no hold is in place. See
   * [[../libraries/order-holds]]. Null on virtually every order — filled only when the raise-time
   * `attemptAllergenHold` stamped a hold or refusal on it.
   */
  hold_status: string | null;
  hold_kind: string | null;
  hold_reason: string | null;
  hold_placed_at: string | null;
  hold_refused_reason: string | null;
}

export interface LinkedReturnRow {
  id: string;
  customer_id: string | null;
  status: string | null;
  tracking_number: string | null;
  net_refund_cents: number | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Subscriptions across the ticket customer's entire link group ([[../libraries/customer-links]] —
 * a person with two records has both records feed one history). `linkGroupIds` returns
 * `[customerId]` when there is no group, so this is a safe drop-in for an `.eq`. Ground truth:
 * ticket a4e79e9d — the customer's records were linked 2026-06-15 and the surface still bare-
 * .eq'd on the record the email landed on, so 29 orders and 3 subs rendered as 0.
 */
export async function getLinkedSubscriptions(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<LinkedSubscriptionRow[]> {
  const ids = await linkGroupIds(admin, workspaceId, customerId);
  const { data } = await admin
    .from("subscriptions")
    .select("id, customer_id, status, next_billing_date, last_payment_status, items")
    .eq("workspace_id", workspaceId)
    .in("customer_id", ids);
  return (data as LinkedSubscriptionRow[]) ?? [];
}

/**
 * Recent orders across the ticket customer's entire link group. `limit` caps rows and defaults
 * to the same 6 the founder queue surface printed (open-tickets.ts) — the widening is what
 * matters, not the shape. Ordered newest first.
 */
export async function getLinkedOrders(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  limit: number = 6,
): Promise<LinkedOrderRow[]> {
  const ids = await linkGroupIds(admin, workspaceId, customerId);
  const { data } = await admin
    .from("orders")
    .select(
      "order_number, customer_id, financial_status, fulfillment_status, total_cents, created_at, delivery_status, delivered_at, amplifier_status, amplifier_tracking_number, line_items, " +
        // a-flagged-allergen-order-must-not-ship Phase 2 — hold columns feed the ticket-context
        // renderers so every surface that shows this order can print the hold-state line.
        "hold_status, hold_kind, hold_reason, hold_placed_at, hold_refused_reason",
    )
    .eq("workspace_id", workspaceId)
    .in("customer_id", ids)
    .order("created_at", { ascending: false })
    .limit(limit);
  // Widened select (Phase 2 hold_* columns) pushes Supabase's inferred row type past its
  // schema-derived shape; `unknown` cast keeps the caller-facing type honest without
  // masking a real read failure — a query error still surfaces as `null` → `[]`.
  return (data as unknown as LinkedOrderRow[]) ?? [];
}

/** Returns across the ticket customer's entire link group (newest first, capped). */
export async function getLinkedReturns(
  admin: Admin,
  workspaceId: string,
  customerId: string,
  limit: number = 6,
): Promise<LinkedReturnRow[]> {
  const ids = await linkGroupIds(admin, workspaceId, customerId);
  const { data } = await admin
    .from("returns")
    .select("id, customer_id, status, tracking_number, net_refund_cents, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .in("customer_id", ids)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as LinkedReturnRow[]) ?? [];
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
  /**
   * Every customer UUID in the ticket customer's link group (self included). Populated via
   * [[customer-links]] `linkGroupIds` so a linked person's whole history renders regardless of
   * which record the message landed on. `[]` when the ticket has no customer_id.
   */
  linkedCustomerIds: string[];
  /** Subscriptions across the whole link group, not just the ticket's record. */
  subscriptions: LinkedSubscriptionRow[];
  /** Recent orders across the whole link group, newest first. */
  orders: LinkedOrderRow[];
  /** Returns across the whole link group, newest first. */
  returns: LinkedReturnRow[];
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
      linkedCustomerIds: [],
      subscriptions: [],
      orders: [],
      returns: [],
    };
  }
  // Commerce reads widen across the customer's link group so a linked person shows one combined
  // history regardless of which record the message arrived on. Empty when the ticket has no
  // customer_id — the loyalty / dunning ticket bodies with no customer entity attached.
  const cid = ticket.customer_id;
  const [customer, messages, directions, handleJobs, mergedFrom, linkedCustomerIds, subscriptions, orders, returns] =
    await Promise.all([
      getCustomerLite(admin, cid),
      getTicketMessages(admin, ticket.id),
      getTicketDirections(admin, ticket.id),
      getTicketHandleJobs(admin, ticket.workspace_id, ticket.id),
      getMergedFromTickets(admin, ticket.id),
      cid ? linkGroupIds(admin, ticket.workspace_id, cid) : Promise.resolve<string[]>([]),
      cid ? getLinkedSubscriptions(admin, ticket.workspace_id, cid) : Promise.resolve<LinkedSubscriptionRow[]>([]),
      cid ? getLinkedOrders(admin, ticket.workspace_id, cid) : Promise.resolve<LinkedOrderRow[]>([]),
      cid ? getLinkedReturns(admin, ticket.workspace_id, cid) : Promise.resolve<LinkedReturnRow[]>([]),
    ]);
  return {
    ref: { requested: requestedId, resolved: resolvedId, redirected },
    ticket,
    customer,
    messages,
    directions,
    handleJobs,
    mergedFrom,
    linkedCustomerIds,
    subscriptions,
    orders,
    returns,
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
