/**
 * Remediation for "Portal action needs help" tickets.
 *
 * When a customer hits an error doing a self-serve portal action (change date,
 * redeem points, cancel-flow line-item edit, …) the portal route creates a
 * ticket tagged `portal-action-failed` (see `app/api/portal/route.ts`). Those
 * tickets have no customer message, so the AI pipeline never runs on them —
 * they just pile up.
 *
 * This module triages each one into:
 *   • retry   — a transient Appstle/infra error (operation lock, gateway).
 *               Re-run the original action; close on success.
 *   • dismiss — a user/UI validation error that can't be "completed" (not
 *               enough points, removing the only product). The UI should have
 *               blocked it; there's nothing to do but close it out.
 *   • human   — anything we don't recognize, auto-heal exhausted, no replay for
 *               the route, or a non-transient error on retry. Escalate the
 *               ticket to the workspace owner (sets escalated_to/escalated_at/
 *               escalation_reason) so it lands in the escalation queue — a
 *               needs-human tag alone was invisible to every human queue.
 *
 * The same `remediatePortalTicket()` is used by the manual one-off pass and the
 * `portal-action-healer` cron, so behaviour is identical.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { appstleUpdateNextBillingDate, appstleUpdateBillingInterval } from "@/lib/appstle";

const PORTAL_FAIL_TAG = "portal-action-failed";
// Route slugs the portal uses for a cancel (see src/lib/portal/handlers/index.ts).
const CANCEL_ROUTES = new Set(["cancel", "canceljourney", "cancelJourney", "cancel_journey"]);
const MAX_HEAL_ATTEMPTS = 3;
const HEAL_NOTE_PREFIX = "[Auto-heal attempt";

export type Disposition = "retry" | "dismiss" | "human";

export interface FailureContext {
  route: string;
  error: string;
  status: number | null;
  payload: Record<string, unknown>;
}

export interface TicketRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  subject: string | null;
  created_at: string;
  assigned_to: string | null;
  escalated_to: string | null;
  escalated_at: string | null;
  tags: string[] | null;
}

/** Extract the route slug from the ticket subject. */
export function routeFromSubject(subject: string | null): string {
  return (subject || "").replace(/^Portal action needs help:\s*/i, "").trim();
}

/**
 * Resolve the structured failure context for a ticket. Primary source is the
 * `portal.error` customer_event (full route + error + request_payload). The
 * *latest* matching event wins — a customer who retried a date change three
 * times wants the date from their last attempt, not the first.
 *
 * Falls back to parsing the system note for older tickets that predate the
 * customer-event write.
 */
export async function getFailureContext(
  admin: SupabaseClient,
  ticket: TicketRow,
): Promise<FailureContext | null> {
  const route = routeFromSubject(ticket.subject);
  if (ticket.customer_id) {
    const since = new Date(new Date(ticket.created_at).getTime() - 2 * 60_000).toISOString();
    const { data: events } = await admin
      .from("customer_events")
      .select("properties, created_at")
      .eq("workspace_id", ticket.workspace_id)
      .eq("customer_id", ticket.customer_id)
      .eq("event_type", "portal.error")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(30);
    const rows = (events || []) as { properties: Record<string, unknown> }[];
    const match =
      rows.find((e) => (e.properties?.route as string) === route) || rows[0];
    if (match) {
      const p = match.properties || {};
      return {
        route: (p.route as string) || route,
        // Include `detail` — handlers carry their friendly text there, not in
        // `message`. Folding it in lets the text-matching dismiss branches fire.
        error: [p.error, p.message, p.detail].filter(Boolean).join(" — ") || "",
        status: typeof p.status === "number" ? (p.status as number) : null,
        payload: (p.request_payload as Record<string, unknown>) || {},
      };
    }
  }
  // Fallback: parse the creation note.
  const { data: note } = await admin
    .from("ticket_messages")
    .select("body")
    .eq("ticket_id", ticket.id)
    .eq("author_type", "system")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const body = (note?.body as string) || "";
  if (!body) return null;
  const error = (body.match(/Error:\s*(.+)/)?.[1] || "").trim();
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(body.match(/Details:\s*(\{[\s\S]*\})/)?.[1] || "{}"); } catch { /* ignore */ }
  return { route, error, status: null, payload };
}

/**
 * Decide what to do with a failure. Order matters: recognized user/validation
 * errors are dismissed before the transient check, because the portal wraps
 * every Appstle error as HTTP 502 — so the status code is NOT a reliable
 * transient signal. We key off the error *message*.
 */
export function classifyPortalFailure(
  ctx: FailureContext,
): { disposition: Disposition; reason: string } {
  const e = (ctx.error || "").toLowerCase();

  // ── Permanent user/UI validation errors → dismiss ──
  if (e.includes("insufficient points") || e.includes("insufficient_points")) {
    return {
      disposition: "dismiss",
      reason:
        "Customer selected a reward they didn't have enough points for. The portal should never offer an unaffordable tier — UI gating issue, nothing to complete.",
    };
  }
  // Match the normalized codes too — route.ts records body.error (the stable
  // code), so the raw Appstle strings below never appear on a portal-created
  // ticket. would_remove_all_regular_products is the replace-variants sibling.
  // The friendly detail substring ("at least one recurring item must remain") is
  // the text remove-line-item now surfaces in `detail`; getFailureContext folds
  // it into `error`, so match it too in case a path carries the text without the
  // code. The legacy raw Appstle strings stay as a fallback for old tickets.
  if (
    e.includes("would_remove_last_item") ||
    e.includes("would_remove_all_regular_products") ||
    e.includes("at least one recurring item must remain") ||
    e.includes("at least one subscription product") ||
    e.includes("atleast one subscription product") ||
    e.includes("cannot remove line item")
  ) {
    return {
      disposition: "dismiss",
      reason:
        "Customer tried to remove the only product on the subscription. Invalid request the cancel flow should have blocked — nothing to complete.",
    };
  }

  // ── Transient Appstle/infra errors → retry ──
  const transient =
    e.includes("operation is already in progress") ||
    e.includes("billing operation is already in progress") ||
    e.includes("please wait until all ongoing processes") ||
    e.includes("timeout") ||
    e.includes("etimedout") ||
    e.includes("econnreset") ||
    e.includes("rate limit") ||
    e.includes("too many requests") ||
    [429, 503, 504].includes(Number(ctx.status));
  if (transient) {
    return {
      disposition: "retry",
      reason: "Transient error (Appstle operation lock / gateway). Safe to re-run the action.",
    };
  }

  // ── Unknown → human ──
  return { disposition: "human", reason: "Unrecognized portal error — needs a human to review." };
}

/**
 * Re-run the original portal action. Only idempotent, safe-to-replay routes are
 * implemented; anything else returns `unsupported` so the caller routes it to a
 * human instead of guessing.
 */
export async function healPortalAction(
  admin: SupabaseClient,
  workspaceId: string,
  ctx: FailureContext,
): Promise<{ success: boolean; detail?: string; error?: string; unsupported?: boolean }> {
  switch (ctx.route) {
    case "changedate":
    case "change_date": {
      const contractId = String(ctx.payload?.contractId || "");
      const date = String(ctx.payload?.nextBillingDate || "");
      if (!contractId || !date) return { success: false, error: "missing contractId/nextBillingDate in payload" };
      const r = await appstleUpdateNextBillingDate(workspaceId, contractId, date);
      if (!r.success) return { success: false, error: r.error || "date update failed" };
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date;
      await admin
        .from("subscriptions")
        .update({ next_billing_date: iso, updated_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId);
      const label = new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      return { success: true, detail: `next order date set to ${label}` };
    }
    case "frequency": {
      // Mirror the changedate shape: replay the same appstle call the portal
      // handler makes. appstleUpdateBillingInterval has a same-value no-op guard
      // (subscriptions.billing_interval + count already match → returns success
      // without hitting Appstle), so a replay of a change that already landed is
      // harmless and closes the ticket instead of escalating a transient failure
      // whose retry the customer already completed themselves.
      const contractId = String(ctx.payload?.contractId || "");
      const intervalRaw = String(ctx.payload?.interval || "").toUpperCase();
      const intervalCount = Number(ctx.payload?.intervalCount || 0);
      if (!contractId) return { success: false, error: "missing contractId in payload" };
      if (!intervalCount || !Number.isFinite(intervalCount)) {
        return { success: false, error: "missing intervalCount in payload" };
      }
      if (intervalRaw !== "DAY" && intervalRaw !== "WEEK" && intervalRaw !== "MONTH" && intervalRaw !== "YEAR") {
        return { success: false, error: `invalid interval "${String(ctx.payload?.interval ?? "")}" (expected DAY/WEEK/MONTH/YEAR)` };
      }
      const r = await appstleUpdateBillingInterval(workspaceId, contractId, intervalRaw, intervalCount);
      if (!r.success) return { success: false, error: r.error || "frequency update failed" };
      return { success: true, detail: `frequency set to every ${intervalCount} ${intervalRaw.toLowerCase()}(s)` };
    }
    default:
      return { success: false, unsupported: true, error: `no replay implemented for route "${ctx.route}"` };
  }
}

/**
 * Did the customer already get what the failed date-change was trying to do —
 * without us? Two signals, both scoped to the exact subscription:
 *   (a) they successfully changed the date themselves after the error
 *       (`portal.date.changed` event for this contract), or
 *   (b) they wanted the order *sooner* (requested date earlier than the current
 *       scheduled date) and an order has since landed on this subscription —
 *       e.g. they found the "Order now" button. (Real case: SC132357, placed
 *       ~40s after the date error, 2026-06-10.)
 *
 * We require the "sooner" direction for (b) so we never auto-dismiss a *delay*
 * request just because the cycle billed anyway — that's the opposite of resolved.
 */
async function changedateSelfResolved(
  admin: SupabaseClient,
  workspaceId: string,
  ctx: FailureContext,
  ticket: TicketRow,
): Promise<{ resolved: boolean; reason?: string }> {
  const contractId = String(ctx.payload?.contractId || "");
  if (!contractId || !ticket.customer_id) return { resolved: false };
  const failTime = ticket.created_at;

  // (a) Customer re-did the date change successfully.
  const { data: changed } = await admin
    .from("customer_events")
    .select("created_at, properties")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", ticket.customer_id)
    .eq("event_type", "portal.date.changed")
    .gte("created_at", failTime)
    .limit(20);
  const reDid = (changed || []).find(
    (e) => String((e.properties as Record<string, unknown>)?.shopify_contract_id || "") === contractId,
  );
  if (reDid) {
    return { resolved: true, reason: `customer successfully changed the next order date herself after the error (${String(reDid.created_at).slice(0, 10)})` };
  }

  // (b) Wanted it sooner + an order has since landed on this subscription.
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, next_billing_date")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (!sub?.id) return { resolved: false };
  const requested = new Date(String(ctx.payload?.nextBillingDate || "").slice(0, 10) + "T00:00:00Z");
  const current = sub.next_billing_date ? new Date(sub.next_billing_date as string) : null;
  const wantedSooner = current && !isNaN(requested.getTime()) && requested < current;
  if (wantedSooner) {
    const { data: orders } = await admin
      .from("orders")
      .select("created_at")
      .eq("subscription_id", sub.id)
      .gte("created_at", failTime)
      .order("created_at", { ascending: false })
      .limit(1);
    if (orders && orders.length) {
      return { resolved: true, reason: `customer wanted her next order sooner and an order landed on this subscription right after the error (${String(orders[0].created_at).slice(0, 10)}) — the date change is moot` };
    }
  }
  return { resolved: false };
}

/**
 * Did the frequency change the customer wanted already land — without us?
 * The real case (ticket a7f9c0ed): a transient Appstle failure spawned a
 * portal-action-failed ticket for a frequency change; the customer retried and
 * the change went through. By the time the healer looks at the stale ticket the
 * subscription is already on the requested interval + count, so escalating it
 * to a human is noise.
 *
 * Two signals, both scoped to the exact subscription:
 *   (a) a `portal.subscription.frequency_changed` customer_event for this
 *       contract at or after the ticket was created (the customer's successful
 *       retry — the frequency handler logs this event on every success), or
 *   (b) the subscriptions row's stored billing_interval + billing_interval_count
 *       already match the ctx request payload (covers a change that landed by
 *       any path — portal retry, webhook, or an internal fix — since the
 *       failure). This mirrors the same-value no-op guard in
 *       appstleUpdateBillingInterval, so what would be a no-op replay is
 *       recognized as already-landed here and closes without the API call.
 */
export async function frequencySelfResolved(
  admin: SupabaseClient,
  workspaceId: string,
  ctx: FailureContext,
  ticket: TicketRow,
): Promise<{ resolved: boolean; reason?: string }> {
  const contractId = String(ctx.payload?.contractId || "");
  if (!contractId) return { resolved: false };
  const failTime = ticket.created_at;

  // (a) Customer re-did the frequency change successfully after the error.
  if (ticket.customer_id) {
    const { data: changed } = await admin
      .from("customer_events")
      .select("created_at, properties")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", ticket.customer_id)
      .eq("event_type", "portal.subscription.frequency_changed")
      .gte("created_at", failTime)
      .limit(20);
    const reDid = ((changed || []) as { created_at: string; properties: Record<string, unknown> }[]).find(
      (e) => String(e.properties?.shopify_contract_id || "") === contractId,
    );
    if (reDid) {
      return {
        resolved: true,
        reason: `customer successfully changed the frequency herself after the error (${String(reDid.created_at).slice(0, 10)})`,
      };
    }
  }

  // (b) The subscription already matches the requested frequency (by any path).
  // Bail if the request payload is malformed — without a target interval+count
  // we can't tell "already matches" from "unknown state", so we shouldn't claim
  // resolved. The heal path will validate + surface the same shape mismatch.
  const requestedInterval = String(ctx.payload?.interval || "").toUpperCase();
  const requestedCount = Number(ctx.payload?.intervalCount || 0);
  if (!requestedInterval || !requestedCount || !Number.isFinite(requestedCount)) {
    return { resolved: false };
  }
  const { data: sub } = await admin
    .from("subscriptions")
    .select("billing_interval, billing_interval_count")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (
    sub &&
    String(sub.billing_interval || "").toUpperCase() === requestedInterval &&
    Number(sub.billing_interval_count) === requestedCount
  ) {
    return {
      resolved: true,
      reason: `the subscription is already on every ${requestedCount} ${requestedInterval.toLowerCase()}(s) — the frequency change landed without us`,
    };
  }

  return { resolved: false };
}

/**
 * Did the customer already cancel this subscription themselves — without us?
 * The real case (ticket 28593e8a): Appstle returned a transient 400 on the first
 * confirm_cancel (a renewal had just billed), the portal made a failed ticket,
 * the customer retried and succeeded a minute later. By the time the healer
 * looks at the stale ticket the sub is already cancelled, so escalating it to a
 * human is noise.
 *
 * Two signals, both scoped to the exact subscription:
 *   (a) a `portal.subscription.cancelled` customer_event for this contract at or
 *       after the ticket was created (the customer's successful retry), or
 *   (b) the subscriptions row for this contract is now status='cancelled'
 *       (covers a cancel that landed by any path — portal retry, webhook, or a
 *       human — since the failure).
 */
async function cancelSelfResolved(
  admin: SupabaseClient,
  workspaceId: string,
  ctx: FailureContext,
  ticket: TicketRow,
): Promise<{ resolved: boolean; reason?: string }> {
  const contractId = String(ctx.payload?.contractId || "");
  if (!contractId) return { resolved: false };
  const failTime = ticket.created_at;

  // (a) Customer re-did the cancel successfully after the error.
  if (ticket.customer_id) {
    const { data: cancelled } = await admin
      .from("customer_events")
      .select("created_at, properties")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", ticket.customer_id)
      .eq("event_type", "portal.subscription.cancelled")
      .gte("created_at", failTime)
      .limit(20);
    const reCancelled = (cancelled || []).find(
      (e) => String((e.properties as Record<string, unknown>)?.shopify_contract_id || "") === contractId,
    );
    if (reCancelled) {
      return { resolved: true, reason: `customer successfully cancelled the subscription herself after the error (${String(reCancelled.created_at).slice(0, 10)})` };
    }
  }

  // (b) The subscription is now cancelled regardless of path.
  const { data: sub } = await admin
    .from("subscriptions")
    .select("status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (sub?.status === "cancelled") {
    return { resolved: true, reason: "the subscription is already cancelled — the cancel landed without us" };
  }

  return { resolved: false };
}

async function sysNote(admin: SupabaseClient, ticketId: string, body: string) {
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "inbound",
    visibility: "internal",
    author_type: "system",
    body,
  });
}

async function closeTicket(admin: SupabaseClient, ticketId: string) {
  await admin
    .from("tickets")
    .update({ status: "closed", closed_at: new Date().toISOString(), updated_at: new Date().toISOString(), escalated_at: null, escalated_to: null, escalation_reason: null })
    .eq("id", ticketId);
}

async function addTag(admin: SupabaseClient, ticket: TicketRow, tag: string) {
  const tags = ticket.tags || [];
  if (tags.includes(tag)) return;
  await admin.from("tickets").update({ tags: [...tags, tag] }).eq("id", ticket.id);
}

/**
 * Escalate a portal-action-failed ticket to the AI Routine. Sets `escalated_at`
 * + `escalation_reason` with `escalated_to = null` (the idle-triage cron's
 * "routine-owned" signal) so the ticket enters the escalation queue that
 * `/api/escalated` and the `escalated=true` ticket filter surface — a
 * needs-human tag alone was invisible to every human queue. The routine triages
 * it next tick (solver→skeptic→quorum) and its no-quorum path is what hands up
 * to a real human.
 *
 * Setting `escalated_at` also becomes the idempotency guard: the hand-off check
 * at the top of `remediatePortalTicket()` short-circuits once it's set, so the
 * cron never re-runs the action on an already-escalated ticket. (Previously the
 * guard keyed on `escalated_to`; now that routine escalations leave that null,
 * the guard keys on `escalated_at`.)
 */
async function escalate(admin: SupabaseClient, ticket: TicketRow, reason: string) {
  const now = new Date().toISOString();
  await admin
    .from("tickets")
    .update({ escalated_to: null, escalated_at: now, escalation_reason: reason, updated_at: now })
    .eq("id", ticket.id);
}

export type RemediationOutcome =
  | { action: "healed"; detail: string }
  | { action: "dismissed"; reason: string }
  | { action: "retry_pending"; attempt: number; error: string }
  | { action: "escalated"; reason: string }
  | { action: "skipped"; reason: string };

/**
 * Triage + act on a single portal-action-failed ticket. Idempotent and safe to
 * run repeatedly (the cron does). Skips tickets a human has already taken.
 */
export async function remediatePortalTicket(
  admin: SupabaseClient,
  ticket: TicketRow,
): Promise<RemediationOutcome> {
  // A human has it (assigned or escalated to a specific person), or it's already
  // escalated (to the routine or a human) — hands off. The escalated_at check is
  // the idempotency guard for our own routine escalations below (which leave
  // escalated_to null).
  if (ticket.assigned_to || ticket.escalated_to || ticket.escalated_at) {
    return { action: "skipped", reason: "human-assigned" };
  }
  // Legacy backlog: before escalation existed, tickets triaged to a human were
  // only tagged `needs-human` and never entered the escalation queue, so they
  // piled up unseen. If we encounter one, escalate it now (it already needs a
  // human) instead of re-running the action — then the guard above catches it on
  // the next tick. New triage escalates directly (see the branches below).
  if ((ticket.tags || []).includes("needs-human")) {
    await escalate(admin, ticket, "Previously triaged to a human but never escalated (needs-human backlog).");
    return { action: "escalated", reason: "needs-human backlog" };
  }

  const ctx = await getFailureContext(admin, ticket);
  if (!ctx) {
    const reason = "Could not determine the portal failure context — needs a human to review.";
    await sysNote(admin, ticket.id, `[Triage] ${reason}`);
    await escalate(admin, ticket, reason);
    return { action: "escalated", reason: "no failure context" };
  }

  const { disposition, reason } = classifyPortalFailure(ctx);

  // A cancel the customer completed themselves shouldn't escalate (or retry) —
  // check before any cancel disposition acts. Covers both a transient 400 that
  // now classifies as `retry` (cancel has no replay, so it would otherwise
  // escalate) and an unrecognized error that classifies as `human`.
  if (CANCEL_ROUTES.has(ctx.route)) {
    const sr = await cancelSelfResolved(admin, ticket.workspace_id, ctx, ticket);
    if (sr.resolved) {
      await sysNote(admin, ticket.id, `[Auto-resolve] Self-resolved — ${sr.reason}. Closing without escalating.`);
      await addTag(admin, ticket, "auto-dismissed");
      await closeTicket(admin, ticket.id);
      return { action: "dismissed", reason: sr.reason || "self-resolved" };
    }
  }

  if (disposition === "dismiss") {
    await sysNote(admin, ticket.id, `[Auto-resolve] ${reason}\nAction: ${ctx.route} · Error: ${ctx.error}`);
    await addTag(admin, ticket, "auto-dismissed");
    await closeTicket(admin, ticket.id);
    return { action: "dismissed", reason };
  }

  if (disposition === "human") {
    await sysNote(admin, ticket.id, `[Triage] ${reason}\nAction: ${ctx.route} · Error: ${ctx.error}`);
    await escalate(admin, ticket, reason);
    return { action: "escalated", reason: "escalate to June" };
  }

  // ── retry ──
  // Before re-applying a date change, make sure the customer hasn't already
  // resolved it themselves (re-did the date, or grabbed an order via "Order
  // now"). Re-applying a stale date they no longer need would be wrong.
  if (ctx.route === "changedate" || ctx.route === "change_date") {
    const sr = await changedateSelfResolved(admin, ticket.workspace_id, ctx, ticket);
    if (sr.resolved) {
      await sysNote(admin, ticket.id, `[Auto-resolve] Self-resolved — ${sr.reason}. Closing without re-running the action.`);
      await addTag(admin, ticket, "auto-dismissed");
      await closeTicket(admin, ticket.id);
      return { action: "dismissed", reason: sr.reason || "self-resolved" };
    }
  }
  // Same shape for frequency: if the customer's retry already landed (a
  // frequency_changed event after the failure, or the subscription's stored
  // billing_interval + count already match the request payload), close instead
  // of replaying — see [[frequencySelfResolved]].
  if (ctx.route === "frequency") {
    const sr = await frequencySelfResolved(admin, ticket.workspace_id, ctx, ticket);
    if (sr.resolved) {
      await sysNote(admin, ticket.id, `[Auto-resolve] Self-resolved — ${sr.reason}. Closing without re-running the action.`);
      await addTag(admin, ticket, "auto-dismissed");
      await closeTicket(admin, ticket.id);
      return { action: "dismissed", reason: sr.reason || "self-resolved" };
    }
  }

  // Count prior auto-heal attempts from our own notes (no extra column needed).
  const { data: priorNotes } = await admin
    .from("ticket_messages")
    .select("id, body")
    .eq("ticket_id", ticket.id)
    .eq("author_type", "system")
    .ilike("body", `${HEAL_NOTE_PREFIX}%`);
  const attempt = (priorNotes?.length || 0) + 1;

  if (attempt > MAX_HEAL_ATTEMPTS) {
    const reason = `Auto-heal exhausted after ${MAX_HEAL_ATTEMPTS} attempts — needs a human.`;
    await sysNote(admin, ticket.id, `[Triage] ${reason}\nAction: ${ctx.route} · Last error: ${ctx.error}`);
    await escalate(admin, ticket, reason);
    return { action: "escalated", reason: "max attempts" };
  }

  const heal = await healPortalAction(admin, ticket.workspace_id, ctx);

  if (heal.success) {
    await sysNote(admin, ticket.id, `[Auto-heal] Re-ran ${ctx.route} successfully — ${heal.detail}. Original error was transient.`);
    await closeTicket(admin, ticket.id);
    return { action: "healed", detail: heal.detail || "" };
  }

  if (heal.unsupported) {
    const reason = `Transient error but no automatic replay exists for "${ctx.route}" — needs a human to re-run it.`;
    await sysNote(admin, ticket.id, `[Triage] ${reason}\nError: ${ctx.error}`);
    await escalate(admin, ticket, reason);
    return { action: "escalated", reason: "no replay for route" };
  }

  // Heal failed. Re-classify the *new* error — if it's now permanent, dispose
  // accordingly instead of retrying a doomed action forever.
  const recheck = classifyPortalFailure({ ...ctx, error: heal.error || ctx.error });
  if (recheck.disposition === "dismiss") {
    await sysNote(admin, ticket.id, `[Auto-resolve] Retry surfaced a permanent error — ${recheck.reason}\nError: ${heal.error}`);
    await addTag(admin, ticket, "auto-dismissed");
    await closeTicket(admin, ticket.id);
    return { action: "dismissed", reason: recheck.reason };
  }
  if (recheck.disposition === "human") {
    const reason = "Retry surfaced a non-transient error — needs a human.";
    await sysNote(admin, ticket.id, `[Triage] ${reason}\nError: ${heal.error}`);
    await escalate(admin, ticket, reason);
    return { action: "escalated", reason: "non-transient on retry" };
  }

  // Still transient — leave open, log the attempt, next cron tick retries.
  await sysNote(admin, ticket.id, `${HEAL_NOTE_PREFIX} ${attempt}] still failing (transient): ${heal.error}. Will retry on the next pass.`);
  return { action: "retry_pending", attempt, error: heal.error || "" };
}

/**
 * Fetch open portal-action-failed tickets eligible for remediation. Limited to
 * the recent window so the cron doesn't churn ancient tickets forever.
 */
export async function fetchOpenPortalFailures(
  admin: SupabaseClient,
  workspaceId: string,
  windowDays = 14,
): Promise<TicketRow[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const { data } = await admin
    .from("tickets")
    .select("id, workspace_id, customer_id, subject, created_at, assigned_to, escalated_to, escalated_at, tags")
    .eq("workspace_id", workspaceId)
    .contains("tags", [PORTAL_FAIL_TAG])
    .eq("status", "open")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(200);
  return (data || []) as TicketRow[];
}
