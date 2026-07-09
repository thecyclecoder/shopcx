/**
 * move-replacement-offer — Phase 2 of
 * docs/brain/specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend.md.
 *
 * When Sol's Phase-1 move-triggered address-update journey completes and a customer's
 * shipping address is written to the active subscription, this SDK decides whether to
 * ALSO offer them a $0 replacement of a recent order that shipped (or will ship) to
 * the OLD address — reusing the address the customer JUST validated in the journey, so
 * we never re-ask.
 *
 * Design guardrails:
 *
 *   - The offer is EXPLICIT (never auto-granted). We insert an outbound customer-visible
 *     message asking the customer, and stash the offer state on `tickets.playbook_context`
 *     under `pending_move_replacement_offer` — acceptance is a downstream turn calling
 *     `acceptMoveReplacementOffer` (which validates the offer is still pending, then
 *     dispatches through the shared replacement path).
 *   - Eligibility mirrors the refund playbook's Tier-1 threshold (LTV ≥ $100 OR total
 *     orders ≥ 3): a save-worthy customer, not a first-purchase-and-abscond risk. Cross-ref
 *     [[../../docs/brain/playbooks/refund.md]] § Tier 1 — Return for Store Credit.
 *   - Recent-order gate: an order created in the last 21 days with a Shopify id (has
 *     been through fulfillment) — no offer against a stale ledger.
 *   - Confirming predicate at the mutation point (learning #6): `acceptMoveReplacementOffer`
 *     re-reads the pending offer AND asserts the ticket still owns it before firing
 *     `issueReplacement`; a raced/stale offer bails without a duplicate replacement.
 *
 * Pure — no filesystem, no network. `admin` is injected by the caller (the journey
 * completion route). `issueReplacement` on the accept path is dep-injected so the tests
 * can drive it deterministically without standing up Supabase + Shopify.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IssueReplacementArgs,
  IssueReplacementResult,
} from "./commerce/replacement";

type Admin = SupabaseClient;

/**
 * LTV threshold (in cents) that satisfies the eligibility gate on its own. Mirrors the
 * refund playbook's Tier-1 "long-tenured" bar — see [[../../docs/brain/playbooks/refund.md]].
 * A customer whose lifetime revenue clears $100 is worth the save gesture of a $0
 * replacement shipment when they've moved.
 */
export const MOVE_REPLACEMENT_ELIGIBILITY_LTV_CENTS = 10000;

/**
 * Total-orders threshold that satisfies the eligibility gate on its own. Mirrors the
 * refund playbook's Tier-1 "long-tenured" bar (3 orders). LTV OR total_orders — either
 * one clears.
 */
export const MOVE_REPLACEMENT_ELIGIBILITY_ORDER_COUNT = 3;

/**
 * "Recent" window in days. An order created outside this window doesn't count as
 * "in-flight / recently shipped" for the move-save offer — we can't reasonably
 * back-date a customer's move to justify replacing a two-month-old order.
 */
export const MOVE_REPLACEMENT_RECENT_ORDER_WINDOW_DAYS = 21;

export interface MoveReplacementCustomerStats {
  ltv_cents: number;
  total_orders: number;
}

export interface EligibilityVerdict {
  eligible: boolean;
  reason: "eligible" | "below_ltv_and_order_count_thresholds";
  ltv_cents: number;
  total_orders: number;
}

/**
 * Pure judge: does this customer clear the move-replacement eligibility bar? LTV ≥ $100
 * OR total_orders ≥ 3 (either / or — same as refund Tier 1). No admin call — the caller
 * hands us the numbers. Kept as a bare function so downstream call sites can synth their
 * own decision without a Supabase round-trip.
 */
export function evaluateMoveReplacementEligibility(
  customer: MoveReplacementCustomerStats,
): EligibilityVerdict {
  const rawLtv = Number(customer.ltv_cents ?? 0);
  const rawOrders = Number(customer.total_orders ?? 0);
  const ltv_cents = Math.max(0, Math.floor(Number.isFinite(rawLtv) ? rawLtv : 0));
  const total_orders = Math.max(0, Math.floor(Number.isFinite(rawOrders) ? rawOrders : 0));
  const eligible =
    ltv_cents >= MOVE_REPLACEMENT_ELIGIBILITY_LTV_CENTS ||
    total_orders >= MOVE_REPLACEMENT_ELIGIBILITY_ORDER_COUNT;
  return {
    eligible,
    reason: eligible ? "eligible" : "below_ltv_and_order_count_thresholds",
    ltv_cents,
    total_orders,
  };
}

export interface RecentOrderForReplacement {
  id: string;
  order_number: string;
  created_at: string;
  shipping_address: Record<string, unknown> | null;
  line_items: Array<Record<string, unknown>>;
  shopify_order_id: string | null;
}

/**
 * Find the most recent order for this customer that clears the "recent + real"
 * bar the move-save uses to justify the replacement — created within
 * `MOVE_REPLACEMENT_RECENT_ORDER_WINDOW_DAYS` and carrying a `shopify_order_id`
 * (i.e., it's been through fulfillment). Returns `null` when no eligible order
 * exists. Read-only.
 */
export async function findRecentEligibleOrderForMoveReplacement(
  admin: Admin,
  workspace_id: string,
  customer_id: string,
  opts?: { now?: Date },
): Promise<RecentOrderForReplacement | null> {
  const now = opts?.now ?? new Date();
  const sinceIso = new Date(
    now.getTime() - MOVE_REPLACEMENT_RECENT_ORDER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await admin
    .from("orders")
    .select("id, order_number, created_at, shipping_address, line_items, shopify_order_id")
    .eq("workspace_id", workspace_id)
    .eq("customer_id", customer_id)
    .gte("created_at", sinceIso)
    .not("shopify_order_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    order_number: string;
    created_at: string;
    shipping_address: Record<string, unknown> | null;
    line_items: unknown;
    shopify_order_id: string | null;
  };
  const line_items = Array.isArray(row.line_items) ? (row.line_items as Array<Record<string, unknown>>) : [];
  return {
    id: row.id,
    order_number: row.order_number,
    created_at: row.created_at,
    shipping_address: row.shipping_address,
    line_items,
    shopify_order_id: row.shopify_order_id,
  };
}

/** Normalized shape of the address stored on the pending offer + used on the accept. */
export interface ValidatedNewAddress {
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

/**
 * Serializable snapshot of a pending offer — stashed under
 * `tickets.playbook_context.pending_move_replacement_offer`. The accept path re-reads
 * this and validates it still matches the ticket before firing. Storing everything
 * downstream needs (order_id, order_number, validated_address, offered_at) means the
 * accept turn does NOT re-ask the customer for anything.
 */
export interface PendingMoveReplacementOffer {
  order_id: string;
  order_number: string;
  validated_address: ValidatedNewAddress;
  offered_at: string;
  eligibility: {
    ltv_cents: number;
    total_orders: number;
  };
}

export interface OfferParams {
  workspace_id: string;
  ticket_id: string;
  customer_id: string;
  validated_address: ValidatedNewAddress;
  now?: Date;
}

export interface OfferResult {
  offered: boolean;
  reason:
    | "offered"
    | "customer_not_found"
    | "not_eligible"
    | "no_recent_order"
    | "offer_already_pending";
  order?: RecentOrderForReplacement;
  ltv_cents?: number;
  total_orders?: number;
  offer_message?: string;
  offer?: PendingMoveReplacementOffer;
}

/**
 * Compose the customer-facing offer text. Explicit, plain-text, no markdown (CLAUDE.md
 * invariant). Mirrors the customer's language ("moved") and re-uses the address they
 * just validated in the journey — do NOT re-ask.
 */
export function composeMoveReplacementOfferMessage(
  orderNumber: string,
  addr: ValidatedNewAddress,
): string {
  const addrLine = [addr.street1, addr.street2 || null, `${addr.city}, ${addr.state} ${addr.zip}`]
    .filter(Boolean)
    .join(", ");
  return (
    `Since you just moved, order ${orderNumber} shipped to your old address. ` +
    `I can send you a free replacement to your new address on file: ${addrLine}. ` +
    `Want me to send it?`
  );
}

/**
 * Top-level orchestrator: gated on eligibility + a recent shipped/in-flight order.
 * Never auto-grants — writes an outbound customer-visible ticket_message asking the
 * customer, stashes the offer under `tickets.playbook_context.pending_move_replacement_offer`,
 * and returns a structured verdict. A non-eligible customer or one with no recent order
 * gets back `offered:false` with a `reason` — the caller (the shipping-address journey
 * completion) is expected to fall through to the normal address-updated confirmation
 * without an offer.
 */
export async function offerMoveReplacementIfEligible(
  admin: Admin,
  params: OfferParams,
): Promise<OfferResult> {
  const { workspace_id, ticket_id, customer_id, validated_address } = params;
  const now = params.now ?? new Date();

  const { data: cust, error: custErr } = await admin
    .from("customers")
    .select("ltv_cents, total_orders")
    .eq("id", customer_id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!cust) return { offered: false, reason: "customer_not_found" };
  const stats = cust as { ltv_cents: number | null; total_orders: number | null };
  const verdict = evaluateMoveReplacementEligibility({
    ltv_cents: stats.ltv_cents ?? 0,
    total_orders: stats.total_orders ?? 0,
  });
  if (!verdict.eligible) {
    return {
      offered: false,
      reason: "not_eligible",
      ltv_cents: verdict.ltv_cents,
      total_orders: verdict.total_orders,
    };
  }

  const recent = await findRecentEligibleOrderForMoveReplacement(admin, workspace_id, customer_id, {
    now,
  });
  if (!recent) {
    return {
      offered: false,
      reason: "no_recent_order",
      ltv_cents: verdict.ltv_cents,
      total_orders: verdict.total_orders,
    };
  }

  // Re-read the ticket's playbook_context so we don't overwrite a pre-existing offer.
  // (Learning #6 — confirming predicate: an offer already pending means the customer
  // hasn't answered yet, and we never stack two offers.)
  const { data: ticket, error: ticketErr } = await admin
    .from("tickets")
    .select("playbook_context")
    .eq("id", ticket_id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();
  if (ticketErr) throw ticketErr;
  const priorCtx = (ticket?.playbook_context ?? {}) as Record<string, unknown>;
  if (priorCtx.pending_move_replacement_offer) {
    return {
      offered: false,
      reason: "offer_already_pending",
      ltv_cents: verdict.ltv_cents,
      total_orders: verdict.total_orders,
      order: recent,
    };
  }

  const offer: PendingMoveReplacementOffer = {
    order_id: recent.id,
    order_number: recent.order_number,
    validated_address,
    offered_at: now.toISOString(),
    eligibility: {
      ltv_cents: verdict.ltv_cents,
      total_orders: verdict.total_orders,
    },
  };

  const message = composeMoveReplacementOfferMessage(recent.order_number, validated_address);

  const updatedCtx = { ...priorCtx, pending_move_replacement_offer: offer };
  const { error: updateErr } = await admin
    .from("tickets")
    .update({ playbook_context: updatedCtx })
    .eq("id", ticket_id)
    .eq("workspace_id", workspace_id);
  if (updateErr) throw updateErr;

  const { error: msgErr } = await admin.from("ticket_messages").insert({
    ticket_id,
    direction: "outbound",
    visibility: "external",
    author_type: "system",
    body: message,
    sent_at: now.toISOString(),
  });
  if (msgErr) throw msgErr;

  return {
    offered: true,
    reason: "offered",
    order: recent,
    ltv_cents: verdict.ltv_cents,
    total_orders: verdict.total_orders,
    offer_message: message,
    offer,
  };
}

/**
 * Acceptance predicate matched against the customer's inbound message. Kept loose but
 * grounded: "yes", "sure", "please send it", "do it", "yes please" all match. A vague
 * question ("what would it cost?") does not. Intentionally does NOT match rejections
 * ("no", "no thanks") — the caller is expected to route those to the normal turn.
 */
export function looksLikeMoveReplacementAcceptance(message: string): boolean {
  const trimmed = (message ?? "").trim().toLowerCase();
  if (!trimmed) return false;
  // Explicit rejection short-circuits (a stray "yes I don't want it" is fine — no verb).
  if (/^(no|nope|no thanks|no thank you|don't|nah|not now|skip)\b/.test(trimmed)) return false;
  return /(^|\b)(yes|yep|yeah|yup|sure|please\s+send|send it|do it|go ahead|go for it|sounds good|absolutely|okay|ok)(\b|!|\.|$)/.test(
    trimmed,
  );
}

export interface AcceptDeps {
  issueReplacement: (
    workspace_id: string,
    args: IssueReplacementArgs,
  ) => Promise<IssueReplacementResult>;
}

export interface AcceptParams {
  workspace_id: string;
  ticket_id: string;
  customer_id: string;
  now?: Date;
}

export interface AcceptResult {
  created: boolean;
  reason:
    | "created"
    | "no_pending_offer"
    | "customer_not_found"
    | "customer_missing_shopify_id"
    | "original_order_not_found"
    | "issue_replacement_failed";
  replacement?: IssueReplacementResult;
  offer?: PendingMoveReplacementOffer;
  error?: string;
}

/**
 * Accept a previously-offered $0 replacement — re-reads the pending offer from
 * `tickets.playbook_context`, dispatches through the SHARED replacement path
 * (`issueReplacement`) with the newly-validated address (never the old one, never
 * re-asked), and clears the pending offer on success. Compare-and-set on the offer:
 * a stale/racing accept bails without a duplicate replacement.
 *
 * Dep-injects `issueReplacement` so the test harness can drive it deterministically.
 * Real callers pass the production wiring imported from `@/lib/commerce/replacement`.
 */
export async function acceptMoveReplacementOffer(
  admin: Admin,
  params: AcceptParams,
  deps: AcceptDeps,
): Promise<AcceptResult> {
  const { workspace_id, ticket_id, customer_id } = params;

  const { data: ticket, error: ticketErr } = await admin
    .from("tickets")
    .select("playbook_context")
    .eq("id", ticket_id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();
  if (ticketErr) throw ticketErr;
  const ctx = (ticket?.playbook_context ?? {}) as Record<string, unknown>;
  const offer = ctx.pending_move_replacement_offer as PendingMoveReplacementOffer | undefined;
  if (!offer || !offer.order_id || !offer.validated_address) {
    return { created: false, reason: "no_pending_offer" };
  }

  const { data: cust, error: custErr } = await admin
    .from("customers")
    .select("shopify_customer_id, first_name, last_name")
    .eq("id", customer_id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!cust) return { created: false, reason: "customer_not_found", offer };
  const customer = cust as {
    shopify_customer_id: string | null;
    first_name: string | null;
    last_name: string | null;
  };
  if (!customer.shopify_customer_id) {
    return { created: false, reason: "customer_missing_shopify_id", offer };
  }

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id, order_number, line_items")
    .eq("id", offer.order_id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order) return { created: false, reason: "original_order_not_found", offer };
  const orderRow = order as {
    id: string;
    order_number: string;
    line_items: unknown;
  };

  const rawItems = Array.isArray(orderRow.line_items) ? (orderRow.line_items as unknown[]) : [];
  const items: Array<{ variantId: string; quantity: number; title?: string }> = [];
  for (const it of rawItems) {
    if (!it || typeof it !== "object") continue;
    const li = it as { variant_id?: unknown; quantity?: unknown; title?: unknown };
    const variantId = typeof li.variant_id === "string" ? li.variant_id : String(li.variant_id ?? "");
    if (!variantId) continue;
    const quantity =
      typeof li.quantity === "number" ? li.quantity : Number(li.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const title = typeof li.title === "string" ? li.title : undefined;
    items.push({ variantId, quantity, title });
  }

  const addr = offer.validated_address;
  const replacement = await deps.issueReplacement(workspace_id, {
    customerId: customer_id,
    shopifyCustomerId: customer.shopify_customer_id,
    items,
    shippingAddress: {
      firstName: customer.first_name ?? undefined,
      lastName: customer.last_name ?? undefined,
      address1: addr.street1,
      address2: addr.street2 ?? undefined,
      city: addr.city,
      province: addr.state,
      zip: addr.zip,
      countryCode: addr.country ?? "US",
    },
    reason: "moved_customer_save",
    originalOrderNumber: orderRow.order_number,
    ticketId: ticket_id,
    customerError: false,
    initiatedBy: "ai",
    initiatedByName: "sol_move_save",
  });

  if (!replacement.success) {
    return {
      created: false,
      reason: "issue_replacement_failed",
      offer,
      error: replacement.error,
      replacement,
    };
  }

  // Clear the pending offer — compare-and-set on the ticket, workspace-scoped, so a
  // concurrent accept can't fire twice (learning #6 — the confirming predicate is at
  // the write, not a coarser proxy). We narrow by workspace + ticket id only; the
  // presence of the pending_move_replacement_offer key is asserted above.
  const nextCtx = { ...ctx };
  delete nextCtx.pending_move_replacement_offer;
  await admin
    .from("tickets")
    .update({ playbook_context: nextCtx })
    .eq("id", ticket_id)
    .eq("workspace_id", workspace_id);

  return { created: true, reason: "created", replacement, offer };
}
