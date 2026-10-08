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
import { errText } from "@/lib/error-text";
// ⭐ Vendor writes go through the commerce SDK, never the Appstle wrapper directly. Calling the
// vendor straight bypasses billing_source resolution, so a migrated subscription's change would
// hit Appstle for a contract it no longer holds — failing there and returning BEFORE the local
// write, leaving the customer's change silently unapplied.
import { subscriptionUpdateNextBillingDate, subscriptionUpdateBillingInterval } from "@/lib/commerce/subscription";

const PORTAL_FAIL_TAG = "portal-action-failed";
// Route slugs the portal uses for a cancel (see src/lib/portal/handlers/index.ts).
const CANCEL_ROUTES = new Set(["cancel", "canceljourney", "cancelJourney", "cancel_journey"]);
// Route slugs for the replaceVariants (item swap) handler. Portal route.ts
// lowercases the incoming ?route= before storing it, so ctx.route arrives as
// "replacevariants" or "replace_variants" — see [[../../app/api/portal/route.ts]].
const REPLACE_VARIANTS_ROUTES = new Set(["replacevariants", "replace_variants"]);
// Route slugs for the immediate-renewal ("Order now") handler. route.ts lowercases the
// incoming ?route= before storing it in the ticket subject + portal.error event, so it
// arrives as "ordernow" or "order_now" — see [[../../app/api/portal/route.ts]].
const ORDER_NOW_ROUTES = new Set(["ordernow", "order_now"]);
const MAX_HEAL_ATTEMPTS = 3;
const HEAL_NOTE_PREFIX = "[Auto-heal attempt";

export type Disposition =
  | "retry"
  | "dismiss"
  | "human"
  /**
   * Phase 4 of [[../../../docs/brain/specs/inflection-resession-must-act-on-newest-ask.md]] —
   * route the customer to the `add-payment-method` journey instead of marking "needs a
   * human" when the portal surfaces a `payment_failed_update_blocked` error. The pure
   * classifier returns this disposition; the DB-aware caller (`remediatePortalTicket`)
   * then (a) auto-dismisses when the subscription is internal OR its newest `dunning_cycles`
   * row has `status='recovered'` (no triage note — the stale blocked-state has recovered),
   * or (b) launches the add-payment-method journey, falling back to escalation if the launch
   * cannot resolve the journey_definitions row.
   */
  | "journey_add_payment_method";

/**
 * Phase 4 of [[../../../docs/brain/specs/inflection-resession-must-act-on-newest-ask.md]] —
 * the error code the dunning helper raises on a payment-method update attempt that is still
 * blocked by the carrier / tokenization fail. Export so the branch below AND
 * `remediatePortalTicket` (DB-aware suppression branch) read the same literal.
 */
export const PAYMENT_FAILED_UPDATE_BLOCKED_ERROR = "payment_failed_update_blocked";

export interface FailureContext {
  route: string;
  error: string;
  status: number | null;
  payload: Record<string, unknown>;
  /**
   * Phase 1 of [[../../../docs/brain/specs/sol-checks-billability-and-delivery-before-answering-order-now-failures.md]].
   * Present ONLY for the `ordernow` / `order_now` route — the extra ground truth Sol needs
   * before she answers an Order Now failure, so she stops GUESSING the shipping state and the
   * subscription's health. On 2026-10-08 Sol told Ashley Denson her delivered order was "on its
   * way" and her stranded sub "will keep coming automatically", then closed the ticket — she
   * pressed Order Now again. These facts let her state the truth instead.
   */
  orderNow?: OrderNowFailureContext;
}

/**
 * Delivery state of the subscription's most recent order + whether its next renewal would
 * actually charge. Sol may claim "on its way" only when `last_order` says so, and promise a
 * future renewal only when `subscription.billable` is true.
 */
export interface OrderNowFailureContext {
  subscription: {
    id: string;
    status: string | null;
    next_billing_date: string | null;
    /** True iff the next renewal would CHARGE (not skip / not stranded). See `computeOrderNowBillability`. */
    nextDateBillable: boolean;
    /** Human-readable reason behind `nextDateBillable` — rendered to Sol so she can explain it honestly. */
    nextDateBillableReason: string;
  } | null;
  /** Delivery truth of the subscription's most recent order — Sol may say "on its way" only when this supports it. */
  lastOrderDelivery: {
    order_number: string | null;
    created_at: string;
    /** Carrier/EasyPost delivery state (e.g. `delivered`, `in_transit`, `out_for_delivery`) — may be null. */
    delivery_status: string | null;
    /** Timestamp the parcel was delivered, when known. A non-null value means it is NOT in transit. */
    delivered_at: string | null;
    fulfillment_status: string | null;
  } | null;
}

/** Shape of the `subscriptions` fields `computeOrderNowBillability` reasons over. */
export interface OrderNowBillabilityInput {
  status: string | null;
  next_billing_date: string | null;
  cancelled_at?: string | null;
  last_payment_status?: string | null;
}

/**
 * Pure predicate: would this subscription's NEXT renewal actually charge, or would it
 * skip / never fire? "Billable" means a renewal landing on `next_billing_date` would place
 * an order. A stranded sub (no date, cancelled, or in dunning) would NOT — and Sol must never
 * tell the customer their coffee "will keep coming automatically" when it won't.
 *
 * Row-derived and deterministic so it can be unit-pinned (`remediation.test.ts`). It does not
 * call Shopify — a date that Shopify later flags unbillable is Phase 2's concern (the refused
 * retime no longer leaves a date behind); here we catch the stranded-sub shapes the row reveals.
 */
export function computeOrderNowBillability(
  sub: OrderNowBillabilityInput,
): { billable: boolean; reason: string } {
  const status = (sub.status || "").toLowerCase();
  if (status === "cancelled" || sub.cancelled_at) {
    return { billable: false, reason: "subscription is cancelled — no renewal will ever charge" };
  }
  if (status !== "active") {
    return { billable: false, reason: `subscription status is '${sub.status ?? "unknown"}', not active — renewal will not charge` };
  }
  if (!sub.next_billing_date) {
    return { billable: false, reason: "no next_billing_date — the subscription is stranded and will never renew on its own" };
  }
  if ((sub.last_payment_status || "").toLowerCase() === "failed") {
    return { billable: false, reason: "last payment failed — the sub is in dunning and the next renewal will skip until the card is fixed" };
  }
  return { billable: true, reason: "active with a future next_billing_date and no failed payment — the next renewal will charge" };
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
      const ctx: FailureContext = {
        route: (p.route as string) || route,
        // Include `detail` — handlers carry their friendly text there, not in
        // `message`. Folding it in lets the text-matching dismiss branches fire.
        error: [p.error, p.message, p.detail].filter(Boolean).join(" — ") || "",
        status: typeof p.status === "number" ? (p.status as number) : null,
        payload: (p.request_payload as Record<string, unknown>) || {},
      };
      return enrichOrderNowContext(admin, ticket, ctx);
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
  return enrichOrderNowContext(admin, ticket, { route, error, status: null, payload });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_CONTRACT_ID = /^[A-Za-z0-9_-]+$/;

interface OrderNowSubRow {
  id: string;
  status: string | null;
  next_billing_date: string | null;
  cancelled_at: string | null;
  last_payment_status: string | null;
}

/**
 * For an `ordernow` / `order_now` failure, attach the delivery state of the subscription's
 * most recent order + whether the sub's next renewal is actually billable. No-op (returns the
 * ctx unchanged) for every other route, or when the subscription can't be resolved — the base
 * triage/escalate behaviour is unaffected.
 *
 * Phase 1 of [[../../../docs/brain/specs/sol-checks-billability-and-delivery-before-answering-order-now-failures.md]].
 */
export async function enrichOrderNowContext(
  admin: SupabaseClient,
  ticket: TicketRow,
  ctx: FailureContext,
): Promise<FailureContext> {
  if (!ORDER_NOW_ROUTES.has((ctx.route || "").toLowerCase())) return ctx;

  // The Order Now payload is keyed by the Shopify contract id the customer pressed.
  const rawContractId = ctx.payload?.contractId ?? ctx.payload?.contract_id;
  const contractId = typeof rawContractId === "string" ? rawContractId.trim() : "";

  // Resolve the subscription. Prefer the exact contract-id match (current OR migrated-from, so a
  // migrated numeric id lands on the live internal row, not the cancelled Appstle shell); fall
  // back to the ticket customer's newest non-cancelled sub when no usable contract id is present.
  let sub: OrderNowSubRow | null = null;

  const subCols = "id, status, next_billing_date, cancelled_at, last_payment_status";
  if (contractId && !UUID_RE.test(contractId) && SAFE_CONTRACT_ID.test(contractId)) {
    const { data } = await admin
      .from("subscriptions")
      .select(subCols)
      .eq("workspace_id", ticket.workspace_id)
      .or(`shopify_contract_id.eq.${contractId},migrated_from_contract_id.eq.${contractId}`)
      // A live row must beat a dead shell (see resolveSub): nulls-first on cancelled_at.
      .order("cancelled_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    sub = (data as OrderNowSubRow | null) || null;
  }
  if (!sub && ticket.customer_id) {
    const { data } = await admin
      .from("subscriptions")
      .select(subCols)
      .eq("workspace_id", ticket.workspace_id)
      .eq("customer_id", ticket.customer_id)
      .order("cancelled_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    sub = (data as OrderNowSubRow | null) || null;
  }
  if (!sub) return ctx;

  const { billable, reason } = computeOrderNowBillability(sub);

  // Most recent order on this subscription — its delivery truth. Sol may only say "on its way"
  // when delivery_status / delivered_at support it.
  const { data: order } = await admin
    .from("orders")
    .select("order_number, created_at, delivery_status, delivered_at, fulfillment_status")
    .eq("workspace_id", ticket.workspace_id)
    .eq("subscription_id", sub.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    ...ctx,
    orderNow: {
      subscription: {
        id: sub.id,
        status: sub.status,
        next_billing_date: sub.next_billing_date,
        nextDateBillable: billable,
        nextDateBillableReason: reason,
      },
      lastOrderDelivery: order
        ? {
            order_number: (order.order_number as string | null) ?? null,
            created_at: order.created_at as string,
            delivery_status: (order.delivery_status as string | null) ?? null,
            delivered_at: (order.delivered_at as string | null) ?? null,
            fulfillment_status: (order.fulfillment_status as string | null) ?? null,
          }
        : null,
    },
  };
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
  // Belt-and-suspenders backstop for the remove-payment-method guard codes. The
  // PRIMARY suppression is [[portal__route]]'s VALIDATION_ERRORS set (stops the
  // ticket spawning at all) — this branch cleans up any that predate the guard
  // or reach classification via another path. Cards are customer-only by PCI
  // design (no agent remedy) and PaymentMethodsSection.tsx already renders plain-
  // language customer guidance for each of these codes, so a guarded refusal is
  // UI-gating validation, not a support event.
  if (
    e.includes("pinned_to_active_subscription") ||
    e.includes("last_card_for_active_subscription") ||
    e.includes("not_removable_here") ||
    e.includes("payment_method_not_found") ||
    e.includes("payment_method_not_in_group") ||
    e.includes("missing_paymentmethodid")
  ) {
    return {
      disposition: "dismiss",
      reason:
        "Remove-payment-method guard rejection. The portal already tells the customer to switch that sub's card, add a replacement first, or remove via the Shopify account — nothing for a human to do.",
    };
  }
  // vault_declined is the SAFE code payment-method-update returns when the vault
  // helper's typed VaultCreateError is classified as a processor decline (the
  // customer's own issuer said no) or a gateway rejection (the merchant's own
  // Braintree risk rule said no). Cards are customer-only by PCI design — the
  // portal already tells the customer to check number/expiry/CVV or try another
  // card, and no agent/human can vault a card for them. Belt-and-suspenders with
  // the PRIMARY suppression in [[portal__route]]'s VALIDATION_ERRORS set (stops
  // the ticket spawning at all). A genuine gateway/config error (SDK broken,
  // misconfig, no_braintree_customer, etc.) keeps returning vault_failed and
  // falls through to the human branch below so a real Braintree outage still
  // surfaces. Real case: ticket ea66c607 (24 retries, 22 tickets on the same
  // decline class before this fix).
  if (e.includes("vault_declined")) {
    return {
      disposition: "dismiss",
      reason:
        "Card decline / gateway rejection on vault. The portal already tells the customer to check the card number, expiry, and CVV or try another card — cards are customer-only by PCI design, nothing for a human to do.",
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

  // ── Phase 4 of inflection-resession-must-act-on-newest-ask ──
  // `payment_failed_update_blocked` fires on an internal/dunning path that TRIED to update
  // the vaulted card but the live gateway said no. The pre-Phase-4 fallback classified this
  // as `human` and emitted `[Triage] Unrecognized portal error`, which stacked on dc31bf31
  // AFTER the dunning cycle had already recovered — the note framed the turn as blocked
  // when the real state was healthy, pulling Sol back toward "needs a human" and away from
  // the actual date-change ask ([[./handlers/change-date]] already exempts internal subs
  // from this error class). The pure classifier marks the branch; `remediatePortalTicket`
  // runs the DB-aware suppression (internal sub / latest dunning_cycles.status='recovered'
  // → dismiss without a triage note) and otherwise routes to the add-payment-method
  // journey instead of escalating.
  if (e.includes(PAYMENT_FAILED_UPDATE_BLOCKED_ERROR)) {
    return {
      disposition: "journey_add_payment_method",
      reason:
        "payment_failed_update_blocked — the live gateway still rejects the vaulted card. Internal sub / recovered dunning → auto-dismiss; otherwise launch the add-payment-method journey (never 'needs a human' silently).",
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
      const r = await subscriptionUpdateNextBillingDate(workspaceId, contractId, date);
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
      const r = await subscriptionUpdateBillingInterval(workspaceId, contractId, intervalRaw, intervalCount);
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

/**
 * Did the customer already get the swap they wanted — without us?
 * The real case (ticket c19bd92b): the first `replaceVariants` call 400'd on a
 * stale `oldLineId`, spawning a portal-action-failed ticket; the retry landed
 * and the sub line is now the requested variant. A generic Appstle 400 on
 * replaceVariants classifies as `human` (there's no `healPortalAction` replay),
 * so — like cancel — this guard must run BEFORE the disposition acts.
 *
 * Two signals, both scoped to the exact subscription:
 *   (a) a `portal.items.swapped` customer_event for this contract at or after
 *       the ticket was created (the customer's successful retry — the handler
 *       logs this event on every successful swap), or
 *   (b) the robust one — the local `subscriptions.items[]` line for this
 *       contract already contains a line whose `variant_id` equals one of the
 *       failed payload's `newVariants` keys (landed by any path: portal retry,
 *       webhook, or an internal fix).
 */
export async function swapSelfResolved(
  admin: SupabaseClient,
  workspaceId: string,
  ctx: FailureContext,
  ticket: TicketRow,
): Promise<{ resolved: boolean; reason?: string }> {
  const contractId = String(ctx.payload?.contractId || "");
  if (!contractId) return { resolved: false };
  const failTime = ticket.created_at;

  // Extract target variant ids from the failed payload's newVariants. Supports
  // both shapes the portal handler accepts: `{ "123": 2 }` and
  // `[{ variantId: "123", quantity: 2 }]`. Strip an optional GID prefix so a
  // "gid://shopify/ProductVariant/123" matches the stored numeric variant_id.
  function normVariant(raw: string): string {
    const t = raw.trim();
    if (!t) return "";
    return t.includes("/") ? (t.split("/").pop() || t) : t;
  }
  const nv = ctx.payload?.newVariants;
  const targetVariantIds: string[] = [];
  if (Array.isArray(nv)) {
    for (const item of nv) {
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const norm = normVariant(String(o.variantId ?? o.id ?? ""));
        if (norm) targetVariantIds.push(norm);
      } else {
        const norm = normVariant(String(item ?? ""));
        if (norm) targetVariantIds.push(norm);
      }
    }
  } else if (nv && typeof nv === "object") {
    for (const k of Object.keys(nv as Record<string, unknown>)) {
      const norm = normVariant(k);
      if (norm) targetVariantIds.push(norm);
    }
  }

  // (a) Customer re-did the swap successfully after the error.
  if (ticket.customer_id) {
    const { data: swapped } = await admin
      .from("customer_events")
      .select("created_at, properties")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", ticket.customer_id)
      .eq("event_type", "portal.items.swapped")
      .gte("created_at", failTime)
      .limit(20);
    const reDid = ((swapped || []) as { created_at: string; properties: Record<string, unknown> }[]).find(
      (e) => String(e.properties?.shopify_contract_id || "") === contractId,
    );
    if (reDid) {
      return {
        resolved: true,
        reason: `customer successfully swapped the subscription items herself after the error (${String(reDid.created_at).slice(0, 10)})`,
      };
    }
  }

  // (b) The subscription's stored items[] already contains one of the target
  // variants. Robust to path — a retry, a webhook, or an internal fix all land
  // in `subscriptions.items` (see replace-variants handler's post-Appstle
  // write) and this guard closes the ticket without any API call.
  if (targetVariantIds.length) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("items")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    const items = (sub?.items as { variant_id?: string | number | null }[] | null | undefined) || [];
    const present = new Set(items.map((i) => String(i?.variant_id ?? "")).filter(Boolean));
    const landed = targetVariantIds.find((v) => present.has(v));
    if (landed) {
      return {
        resolved: true,
        reason: `the subscription already contains the requested variant (${landed}) — the swap landed without us`,
      };
    }
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

/**
 * Phase 4 of [[../../../docs/brain/specs/inflection-resession-must-act-on-newest-ask.md]] —
 * DB-aware suppression predicate for `payment_failed_update_blocked`. Returns `dismiss:true`
 * when the referenced subscription is internal (`subscriptions.is_internal=true` — the same
 * exemption [[./handlers/change-date]] already applies for this error class) OR the
 * subscription's newest `dunning_cycles` row has `status='recovered'`. Pure DB reads scoped
 * to the ticket's `workspace_id` — a scope mismatch returns `dismiss:false` so the caller
 * routes to the add-payment-method journey (or escalates), never silently crosses workspaces.
 *
 * The contract_id comes from the portal error's `request_payload.contractId` the handler
 * always carries; a missing contract_id (shouldn't happen, defensive) returns `dismiss:false`
 * so the caller falls through to the journey launch.
 */
async function payment_failed_update_blocked_is_recovered_or_internal(
  admin: SupabaseClient,
  workspaceId: string,
  ctx: FailureContext,
): Promise<{ dismiss: boolean; reason: string }> {
  const contractId = (ctx.payload?.contractId as string | undefined)?.toString();
  if (!contractId) {
    return { dismiss: false, reason: "no contractId on the failure payload — cannot verify recovered/internal" };
  }
  try {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, is_internal")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    if (sub?.is_internal === true) {
      return {
        dismiss: true,
        reason: `subscription is internal (change-date already exempts this error class for internal subs — contract=${contractId})`,
      };
    }
    // Latest dunning_cycles row for this contract (newest first).
    const { data: cycles } = await admin
      .from("dunning_cycles")
      .select("status, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .order("updated_at", { ascending: false })
      .limit(1);
    const newest = ((cycles as Array<{ status: string | null }> | null) ?? [])[0];
    if (newest?.status === "recovered") {
      return {
        dismiss: true,
        reason: `newest dunning_cycles.status='recovered' for contract=${contractId} (payment already recovered — the triage note would be stale)`,
      };
    }
    return { dismiss: false, reason: "neither internal nor recovered — fall through to journey launch" };
  } catch (e) {
    // A read failure is NOT a dismiss — fall through to the journey launch (and from there to
    // the human escalation if the launch also fails). We never want a DB blip to force a
    // silent close over a genuinely blocked state. Lossless renderer so a supabase-js
    // PostgREST error object preserves its code/details/hint instead of `[object Object]`.
    return { dismiss: false, reason: `recovered/internal probe threw (${errText(e)}) — fall through` };
  }
}

/**
 * Phase 4 of inflection-resession-must-act-on-newest-ask — resolve the active
 * `add-payment-method` journey_definitions row for this workspace + launch it for the
 * customer via [[../journey-delivery]] `launchJourneyForTicket`. Returns ok+detail on a
 * successful delivery; the caller then auto-dismisses the ticket. A missing journey row /
 * missing customer_id / `launchJourneyForTicket` returning false → ok:false with a reason
 * naming the failure class so the caller's escalation sysNote distinguishes the attempt
 * from a bare "unrecognized error".
 */
async function launchAddPaymentMethodJourneyForTicket(
  admin: SupabaseClient,
  ticket: TicketRow,
): Promise<{ ok: boolean; detail?: string; reason?: string }> {
  if (!ticket.customer_id) {
    return { ok: false, reason: "ticket has no customer_id — journey cannot deliver" };
  }
  // Resolve the active add-payment-method journey for this workspace. The journey slug is
  // the same one Phase 3 of checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol
  // pins; here we read it from the DB rather than hard-coding the row id so a workspace that
  // renamed the row's internal id still finds it by slug.
  const { data: journeyRow } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent")
    .eq("workspace_id", ticket.workspace_id)
    .eq("slug", "add-payment-method")
    .eq("is_active", true)
    .maybeSingle();
  const journey = journeyRow as { id: string; name: string; trigger_intent: string } | null;
  if (!journey) {
    return { ok: false, reason: "no active add-payment-method journey in journey_definitions" };
  }
  const { data: tick } = await admin
    .from("tickets")
    .select("channel")
    .eq("id", ticket.id)
    .maybeSingle();
  const channel = (tick?.channel as string | undefined) ?? "email";
  try {
    const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
    const delivered = await launchJourneyForTicket({
      workspaceId: ticket.workspace_id,
      ticketId: ticket.id,
      customerId: ticket.customer_id,
      journeyId: journey.id,
      journeyName: journey.name,
      triggerIntent: journey.trigger_intent,
      channel,
      leadIn:
        "Your card update didn't go through — let me get you to the secure update flow so we can get this sorted. Tap below to add a new payment method.",
      ctaText: "Add Payment Method",
    });
    if (delivered) {
      return { ok: true, detail: `delivered journey '${journey.name}' on channel '${channel}'` };
    }
    return { ok: false, reason: "launchJourneyForTicket returned false (non-deliverable channel or guarded skip)" };
  } catch (e) {
    // Lossless renderer so a supabase-js PostgREST error object preserves its code/details
    // /hint instead of `[object Object]` in the escalation note.
    return { ok: false, reason: `launchJourneyForTicket threw: ${errText(e)}` };
  }
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
  // Same shape for replaceVariants (item swap): a generic Appstle 400 on the
  // first attempt classifies as `human` (no replay in `healPortalAction`), so
  // this guard must run BEFORE the disposition acts — exactly like cancel.
  // Real case: ticket c19bd92b, first replaceVariants 400'd on a stale
  // oldLineId; the retry landed and the sub line is now the requested variant.
  if (REPLACE_VARIANTS_ROUTES.has(ctx.route)) {
    const sr = await swapSelfResolved(admin, ticket.workspace_id, ctx, ticket);
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

  // ── Phase 4 of inflection-resession-must-act-on-newest-ask ──
  // `payment_failed_update_blocked` branch: suppress the stale triage note when the
  // subscription is internal OR its newest dunning_cycles row has status='recovered'
  // (the payment already recovered — [[./handlers/change-date]] already exempts internal
  // subs from this error class). Otherwise launch the add-payment-method journey; on a
  // launch failure (no active journey_definitions row, missing customer_id, delivery
  // threw), fall back to the human escalate so the ticket is never silently dropped.
  if (disposition === "journey_add_payment_method") {
    const dismissed = await payment_failed_update_blocked_is_recovered_or_internal(
      admin,
      ticket.workspace_id,
      ctx,
    );
    if (dismissed.dismiss) {
      await sysNote(
        admin,
        ticket.id,
        `[Auto-resolve] payment_failed_update_blocked — ${dismissed.reason}. Closing without a triage note (no 'needs a human').`,
      );
      await addTag(admin, ticket, "auto-dismissed");
      await closeTicket(admin, ticket.id);
      return { action: "dismissed", reason: dismissed.reason };
    }
    const launched = await launchAddPaymentMethodJourneyForTicket(admin, ticket);
    if (launched.ok) {
      await sysNote(
        admin,
        ticket.id,
        `[Auto-resolve] payment_failed_update_blocked — launched the add-payment-method journey for the customer (${launched.detail}). Closing instead of marking 'needs a human'.`,
      );
      await addTag(admin, ticket, "auto-dismissed");
      await closeTicket(admin, ticket.id);
      return { action: "dismissed", reason: "launched add-payment-method journey" };
    }
    // Launch failed — surface the WHY and fall back to escalate so the ticket is never
    // silently dropped. The sysNote names the attempt so the audit trail distinguishes a
    // genuine human-needs from the pre-Phase-4 blanket "unrecognized" classification.
    await sysNote(
      admin,
      ticket.id,
      `[Triage] payment_failed_update_blocked — could not launch the add-payment-method journey (${launched.reason}). Escalating to June.`,
    );
    await escalate(admin, ticket, reason);
    return { action: "escalated", reason: "payment_failed_update_blocked journey-launch failed" };
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
  if (recheck.disposition === "human" || recheck.disposition === "journey_add_payment_method") {
    // Phase 4 safety-net: a retry that newly SURFACES payment_failed_update_blocked
    // escalates rather than loop back into the journey launch here (we are already
    // mid-heal). The pure classifier's primary journey branch above handles the
    // first-time case; this branch catches the rare "retry revealed it" path.
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
