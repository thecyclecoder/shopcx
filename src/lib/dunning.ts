// Core dunning logic: card rotation, payment method dedup, payday scheduling

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

// ── Types ──

export interface PaymentMethod {
  id: string;            // gid://shopify/CustomerPaymentMethod/...
  last4: string;
  expiryMonth: number;
  expiryYear: number;
  brand: string | null;
  name: string | null;
  dedupeKey: string;     // last4 + expiryMonth + expiryYear
}

export interface DunningSettings {
  dunning_enabled: boolean;
  dunning_max_card_rotations: number;
  dunning_payday_retry_enabled: boolean;
  dunning_cycle_1_action: string;
  dunning_cycle_2_action: string;
}

// ── Shopify GraphQL: Customer Payment Methods ──

// Retry-on-5xx/429/network for the Shopify GraphQL fetch below, mirroring
// fetchWithRetry in shopify-sync.ts. A one-off Shopify upstream 503 was
// exhausting otherwise-recoverable dunning cycles because the caller's catch
// treated a transient blip the same as "customer has zero cards".
const GET_PAYMENT_METHODS_MAX_RETRIES = 3;

export async function getCustomerPaymentMethods(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<PaymentMethod[]> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const query = `{
    customer(id: "gid://shopify/Customer/${shopifyCustomerId}") {
      paymentMethods(first: 10) {
        edges {
          node {
            id
            instrument {
              ... on CustomerCreditCard {
                lastDigits
                expiryMonth
                expiryYear
                brand
                name
              }
              ... on CustomerShopPayAgreement {
                lastDigits
                expiryMonth
                expiryYear
                name
              }
            }
            revokedAt
          }
        }
      }
    }
  }`;

  let res: Response | undefined;
  for (let attempt = 0; attempt <= GET_PAYMENT_METHODS_MAX_RETRIES; attempt++) {
    try {
      res = await fetch(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        }
      );
      if (
        (res.status === 429 || res.status >= 500) &&
        attempt < GET_PAYMENT_METHODS_MAX_RETRIES
      ) {
        const wait = res.status === 429 ? 2000 : 1000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break;
    } catch (err) {
      if (attempt < GET_PAYMENT_METHODS_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  if (!res) {
    throw new Error("Shopify GraphQL: exhausted retries with no response");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${json.errors[0].message}`);
  }

  const edges = json.data?.customer?.paymentMethods?.edges || [];
  const methods: PaymentMethod[] = [];

  for (const edge of edges) {
    const node = edge.node;
    // Skip revoked payment methods
    if (node.revokedAt) continue;

    const instrument = node.instrument;
    if (!instrument?.lastDigits) continue;

    methods.push({
      id: node.id,
      last4: instrument.lastDigits,
      expiryMonth: instrument.expiryMonth || 0,
      expiryYear: instrument.expiryYear || 0,
      brand: instrument.brand || null,
      name: instrument.name || null,
      dedupeKey: `${instrument.lastDigits}-${instrument.expiryMonth}-${instrument.expiryYear}`,
    });
  }

  return methods;
}

// ── Shopify → customer_payment_methods mirror ──

/**
 * Mirror a customer's Shopify Payments cards into customer_payment_methods
 * with provider='shopify'. Dunning's card-rotation reads cards live from
 * Shopify, but the portal / dashboard / Sonnet orchestrator read this
 * table — so an Appstle customer's card was invisible to them (the table
 * was Braintree-only). Called from the customer_payment_methods webhook so
 * the card is captured the moment the customer adds it.
 *
 * Upserts keyed on (workspace_id, shopify_payment_method_id). Only
 * non-revoked cards are captured (getCustomerPaymentMethods drops revoked
 * ones). If the customer has no default active method yet, the first card
 * captured becomes the default so renewal/portal have one to show.
 */
export async function syncShopifyPaymentMethods(
  workspaceId: string,
  customerId: string,
  shopifyCustomerId: string,
): Promise<{ synced: number }> {
  const admin = createAdminClient();

  let cards: PaymentMethod[];
  try {
    cards = await getCustomerPaymentMethods(workspaceId, shopifyCustomerId);
  } catch (err) {
    console.error("[syncShopifyPaymentMethods] Shopify fetch failed:", err);
    return { synced: 0 };
  }
  if (!cards.length) return { synced: 0 };

  const { data: existingDefault } = await admin
    .from("customer_payment_methods")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .eq("is_default", true)
    .eq("status", "active")
    .maybeSingle();
  let needsDefault = !existingDefault;

  let synced = 0;
  for (const card of cards) {
    const fields = {
      payment_type: "credit_card" as const,
      card_brand: card.brand,
      last4: card.last4,
      expiration_month: card.expiryMonth ? String(card.expiryMonth).padStart(2, "0") : null,
      expiration_year: card.expiryYear ? String(card.expiryYear) : null,
      status: "active" as const,
      updated_at: new Date().toISOString(),
    };

    // Check-then-write rather than upsert: the unique index on
    // shopify_payment_method_id is partial (WHERE NOT NULL), which
    // PostgREST's ON CONFLICT inference handles inconsistently.
    const { data: existing } = await admin
      .from("customer_payment_methods")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_payment_method_id", card.id)
      .maybeSingle();

    let error;
    if (existing) {
      ({ error } = await admin.from("customer_payment_methods").update(fields).eq("id", existing.id));
    } else {
      ({ error } = await admin.from("customer_payment_methods").insert({
        workspace_id: workspaceId,
        customer_id: customerId,
        provider: "shopify",
        shopify_payment_method_id: card.id,
        is_default: needsDefault,
        ...fields,
      }));
      if (!error && needsDefault) needsDefault = false; // only the first becomes default
    }
    if (error) {
      console.error(`[syncShopifyPaymentMethods] write failed for ${card.id}:`, error.message);
      continue;
    }
    synced++;
  }

  return { synced };
}

// ── Deduplication ──

export function deduplicatePaymentMethods(methods: PaymentMethod[]): PaymentMethod[] {
  const seen = new Set<string>();
  const unique: PaymentMethod[] = [];

  for (const m of methods) {
    if (!seen.has(m.dedupeKey)) {
      seen.add(m.dedupeKey);
      unique.push(m);
    }
  }

  return unique;
}

// ── Get untried cards ──

export function getUntriedCards(
  methods: PaymentMethod[],
  triedCards: string[],
): PaymentMethod[] {
  return methods.filter(m => !triedCards.includes(m.dedupeKey));
}

// ── Payday Scheduling ──

export function getNextPaydayDates(fromDate: Date, count: number): Date[] {
  const dates: Date[] = [];
  const d = new Date(fromDate);

  // Look ahead up to 45 days to find enough payday dates
  for (let i = 0; i < 45 && dates.length < count; i++) {
    d.setDate(d.getDate() + 1);
    if (isPayday(d)) {
      dates.push(new Date(d));
    }
  }

  return dates;
}

function isPayday(date: Date): boolean {
  const dayOfMonth = date.getDate();
  const dayOfWeek = date.getDay(); // 0=Sun, 5=Fri
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  // 1st of month
  if (dayOfMonth === 1) return true;
  // 15th of month
  if (dayOfMonth === 15) return true;
  // Friday
  if (dayOfWeek === 5) return true;
  // Last business day of month
  if (dayOfMonth === lastDayOfMonth && dayOfWeek >= 1 && dayOfWeek <= 5) return true;
  if (dayOfMonth === lastDayOfMonth - 1 && dayOfWeek === 5) return true; // Friday before weekend last day
  if (dayOfMonth === lastDayOfMonth - 2 && dayOfWeek === 5) return true; // Friday if last day is Sunday

  return false;
}

export function getRetryTime(paydayDate: Date, timezoneOffset: number = -6): Date {
  // Retry at 7 AM in the target timezone (default US Central = UTC-6)
  // 7 AM Central = 7 - (-6) = 13 UTC
  const retry = new Date(paydayDate);
  retry.setUTCHours(7 - timezoneOffset, 0, 0, 0);
  return retry;
}

// ── Dunning Settings ──

export async function getDunningSettings(workspaceId: string): Promise<DunningSettings | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("dunning_enabled, dunning_max_card_rotations, dunning_payday_retry_enabled, dunning_cycle_1_action, dunning_cycle_2_action")
    .eq("id", workspaceId)
    .single();

  if (!data) return null;
  return data as DunningSettings;
}

// ── Dunning Cycle Management ──

export async function getActiveDunningCycle(
  workspaceId: string,
  shopifyContractId: string,
): Promise<{ id: string; cycle_number: number; status: string; cards_tried: string[]; terminal_cards: string[]; billing_attempt_id: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dunning_cycles")
    .select("id, cycle_number, status, cards_tried, terminal_cards, billing_attempt_id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId)
    .in("status", ["active", "rotating", "retrying", "skipped", "paused"])
    .order("cycle_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

export async function getActiveDunningCyclesForCustomer(
  workspaceId: string,
  customerId: string,
): Promise<{ id: string; shopify_contract_id: string; subscription_id: string | null; cycle_number: number; status: string; billing_attempt_id: string | null }[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("dunning_cycles")
    .select("id, shopify_contract_id, subscription_id, cycle_number, status, billing_attempt_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["active", "rotating", "retrying", "skipped", "paused"]);

  return data || [];
}

export async function createDunningCycle(
  workspaceId: string,
  shopifyContractId: string,
  subscriptionId: string | null,
  customerId: string | null,
  billingAttemptId: string | null,
): Promise<{ id: string; cycle_number: number }> {
  const admin = createAdminClient();

  // Determine cycle number by checking previous cycles for this contract
  const { data: prev } = await admin
    .from("dunning_cycles")
    .select("cycle_number")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId)
    .in("status", ["recovered", "exhausted"])
    .order("cycle_number", { ascending: false })
    .limit(1)
    .single();

  const cycleNumber = prev ? prev.cycle_number + 1 : 1;

  const { data, error } = await admin
    .from("dunning_cycles")
    .insert({
      workspace_id: workspaceId,
      shopify_contract_id: shopifyContractId,
      subscription_id: subscriptionId,
      customer_id: customerId,
      cycle_number: cycleNumber,
      status: "rotating",
      billing_attempt_id: billingAttemptId,
    })
    .select("id, cycle_number")
    .single();

  if (error) throw new Error(`Failed to create dunning cycle: ${error.message}`);
  return data!;
}

export async function updateDunningCycle(
  cycleId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("dunning_cycles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", cycleId);
}

/** Cycle states that are still "in flight" — a sub pause/cancel should close these. */
// ⭐ Must stay in step with `idx_dunning_cycles_active_contract`
// (partial unique on status IN ('active','skipped','paused')) and with
// getActiveDunningCycle / getActiveDunningCyclesForCustomer. Omitting 'paused' meant a
// paused CYCLE was never closed by a sub pause/cancel: it still surfaced in
// dunning-new-card-recovery (→ resume + charge, the exact harm this function prevents) and
// still held the unique-index slot with no way to clear it. Nothing writes 'paused' today,
// but the codebase retains it for legacy rows, so the lists must not diverge silently.
export const OPEN_DUNNING_STATUSES = ["active", "rotating", "retrying", "skipped", "paused"] as const;

// ────────────────────────────────────────────────────────────────────────────────────────
// Pure dunning decisions.
//
// Extracted so they can be pinned by tests. Every one of these was a live defect in the
// week of 2026-09-09, and each was invisible because the decision lived inline inside an
// Inngest step that no test could reach. Same idiom as `isRenewalAttemptStale` and
// `filterCandidatesByDunningRetryWindow`.
// ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Statuses covered by `idx_dunning_cycles_active_contract` — the partial UNIQUE index on
 * `(workspace_id, shopify_contract_id) WHERE status IN ('active','skipped','paused')`.
 *
 * ⭐ A cycle left in ANY of these holds the slot, so the next billing failure's cycle insert
 * conflicts, logs "duplicate", never fires `dunning/payment-failed`, and the subscription
 * drops out of dunning permanently. That is why a payday exhaustion must land on a status
 * OUTSIDE this set — `handleAllCardsExhausted`'s skip branch writes `'skipped'`, which is
 * safe on the card-rotation path (step 7 flips it straight back to `retrying`) and fatal on
 * the payday path, where nothing flips it.
 */
export const ACTIVE_SLOT_STATUSES = ["active", "skipped", "paused"] as const;

/** Does a cycle in this status still hold the partial-unique "one active cycle" slot? */
export function holdsActiveCycleSlot(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_SLOT_STATUSES as readonly string[]).includes(status);
}

/** Is this cycle still in flight (and therefore closable by a sub pause/cancel)? */
export function isOpenDunningStatus(status: string | null | undefined): boolean {
  return !!status && (OPEN_DUNNING_STATUSES as readonly string[]).includes(status);
}

/**
 * Must the payday cron STOP retrying because of the subscription's own state?
 *
 * Gated only on "cancelled" until 2026-09-09, so customer-PAUSED subs kept being billed and
 * would have received "your payment failed, update your card" for a subscription they had
 * deliberately paused — one until 2026-10-30.
 */
export function shouldHaltRetryForSubStatus(subStatus: string | null | undefined): boolean {
  return !subStatus || subStatus === "cancelled" || subStatus === "paused";
}

/**
 * Has this cycle used up its payday retries?
 *
 * The cron had no cap at all: its only exit asked `getNextPaydayDates()` for a future payday,
 * which ALWAYS returns one, so the "exhausted" branch was unreachable. Combined with a
 * hardcoded `attemptNumber: 0` on every logged attempt, one cycle reached 192 attempts.
 * A null/undefined count must read as 0, never as "cap reached".
 */
export function shouldExhaustForRetryCap(
  paydayRetryCount: number | null | undefined,
  max: number,
): boolean {
  return (paydayRetryCount ?? 0) >= max;
}

/**
 * Which terminal action does this cycle get — skip, pause or cancel?
 *
 * Cycle 1 gets the gentle action, cycle 2+ the hard one. A null cycle_number must fall back
 * to cycle 1 (the gentler branch), never to cancel.
 */
export function resolveCycleAction(
  cycleNumber: number | null | undefined,
  settings: { dunning_cycle_1_action: string; dunning_cycle_2_action: string },
): string {
  return (cycleNumber ?? 1) >= 2 ? settings.dunning_cycle_2_action : settings.dunning_cycle_1_action;
}

/**
 * End dunning for a subscription because the SUB itself was paused or cancelled.
 *
 * CEO rule (2026-09-09): "a pause or cancellation should end your dunning experience."
 *
 * Two live failures this closes:
 *  1. The payday-retry cron only gated on `status === "cancelled"`, so a customer-paused sub
 *     kept getting billing retries — and would receive a "your payment failed, update your
 *     card" email for a subscription they deliberately paused (one until 2026-10-30).
 *  2. Worse, `dunning-new-card-recovery` treats ANY open cycle on a paused sub as a "legacy
 *     paused" sub and RESUMES it, then charges. So a customer who paused and later updated
 *     their card for an unrelated reason would be resumed and billed.
 *
 * Only closes cycles that are still open. A cycle dunning itself already drove to `exhausted`
 * is left alone, which preserves the deliberate behaviour that adding a card to a
 * DUNNING-cancelled sub reactivates it (see lifecycles/dunning.md Phase 5, fixed 2026-06-09).
 * Sends nothing — this is a silent close, not an exhaustion.
 */
export async function endDunningForSubscription(
  workspaceId: string,
  shopifyContractId: string,
  reason: "paused" | "cancelled",
): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("dunning_cycles")
    .update({
      status: "exhausted",
      next_retry_at: null,
      // NOT terminal_error_code — the dunning analytics panel counts
      // status='exhausted' AND terminal_error_code IS NOT NULL as "terminal cancellations",
      // and a customer-initiated pause/cancel is not one. Provenance goes in a field the
      // panel does not read.
      closed_reason: `subscription_${reason}`,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", shopifyContractId)
    .in("status", OPEN_DUNNING_STATUSES as unknown as string[])
    .select("id");
  if (error) {
    console.error(`[Dunning] endDunningForSubscription(${shopifyContractId}, ${reason}) failed:`, error.message);
    return 0;
  }
  if (data?.length) {
    console.log(`[Dunning] Closed ${data.length} open cycle(s) for ${shopifyContractId} — subscription ${reason}.`);
  }
  return data?.length ?? 0;
}

export async function logPaymentFailure(params: {
  workspaceId: string;
  customerId: string | null;
  subscriptionId: string | null;
  shopifyContractId: string;
  billingAttemptId?: string | null;
  paymentMethodLast4?: string | null;
  paymentMethodId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptNumber: number;
  attemptType: "initial" | "card_rotation" | "payday_retry" | "new_card_retry";
  succeeded: boolean;
  // Lifecycle status: 'pending' = attempt submitted, real outcome pending via
  // webhook; 'failed' = declined; 'succeeded' = charged. Defaults from
  // `succeeded` when omitted. Only count 'failed' rows as real declines.
  result?: "pending" | "failed" | "succeeded";
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from("payment_failures").insert({
    workspace_id: params.workspaceId,
    customer_id: params.customerId,
    subscription_id: params.subscriptionId,
    shopify_contract_id: params.shopifyContractId,
    billing_attempt_id: params.billingAttemptId || null,
    payment_method_last4: params.paymentMethodLast4 || null,
    payment_method_id: params.paymentMethodId || null,
    error_code: params.errorCode || null,
    error_message: params.errorMessage || null,
    attempt_number: params.attemptNumber,
    attempt_type: params.attemptType,
    succeeded: params.succeeded,
    result: params.result ?? (params.succeeded ? "succeeded" : "failed"),
  });
}

/**
 * Resolve a previously-logged PENDING billing attempt (Appstle accepts the
 * attempt, the real result lands later via webhook) to its final state, instead
 * of inserting a duplicate row. Returns true if a pending row was updated.
 */
export async function resolvePendingAttempt(
  workspaceId: string,
  billingAttemptId: string,
  outcome: { result: "failed" | "succeeded"; errorCode?: string | null; errorMessage?: string | null },
): Promise<boolean> {
  if (!billingAttemptId) return false;
  const admin = createAdminClient();
  const { data } = await admin
    .from("payment_failures")
    .update({
      result: outcome.result,
      succeeded: outcome.result === "succeeded",
      error_code: outcome.errorCode ?? null,
      error_message: outcome.errorMessage ?? null,
    })
    .eq("workspace_id", workspaceId)
    .eq("billing_attempt_id", billingAttemptId)
    .eq("result", "pending")
    .select("id");
  return !!data?.length;
}

export async function getLastSuccessfulCard(
  workspaceId: string,
  customerId: string,
): Promise<{ payment_method_id: string; payment_method_last4: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("payment_failures")
    .select("payment_method_id, payment_method_last4")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .eq("succeeded", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  return data && data.payment_method_id ? data as { payment_method_id: string; payment_method_last4: string } : null;
}

// ── Error Code Classification ──

export async function isTerminalErrorCode(
  workspaceId: string,
  errorCode: string | null,
): Promise<boolean> {
  if (!errorCode) return false;
  const admin = createAdminClient();
  const { data } = await admin
    .from("dunning_error_codes")
    .select("is_terminal")
    .eq("workspace_id", workspaceId)
    .eq("error_code", errorCode)
    .single();
  return data?.is_terminal === true;
}

export async function trackErrorCode(
  workspaceId: string,
  errorCode: string | null,
  errorMessage: string | null,
): Promise<void> {
  if (!errorCode) return;
  const admin = createAdminClient();
  // Upsert: increment count if exists, create if new
  const { data: existing } = await admin
    .from("dunning_error_codes")
    .select("id, occurrence_count")
    .eq("workspace_id", workspaceId)
    .eq("error_code", errorCode)
    .maybeSingle();

  if (existing) {
    await admin.from("dunning_error_codes").update({
      occurrence_count: existing.occurrence_count + 1,
      last_seen_at: new Date().toISOString(),
      // Update error_message to latest seen (some codes have multiple messages)
      ...(errorMessage ? { error_message: errorMessage } : {}),
    }).eq("id", existing.id);
  } else {
    // New error code — default is_terminal to false, admin reviews in settings
    await admin.from("dunning_error_codes").insert({
      workspace_id: workspaceId,
      error_code: errorCode,
      error_message: errorMessage,
      is_terminal: false,
      occurrence_count: 1,
    });
  }
}

// ── Internal Note Helpers ──

export function dunningInternalNote(message: string): string {
  return `[System] ${message}`;
}

/**
 * Post an internal note on the customer's most recent open/pending ticket.
 */
export async function postDunningNoteOnTicket(
  workspaceId: string,
  customerId: string | null,
  note: string,
): Promise<void> {
  if (!customerId) return;
  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["open", "pending"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!ticket) return;
  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "internal",
    visibility: "internal",
    author_type: "system",
    body: note,
  });
}

/**
 * Tag all open/pending tickets for a customer with a given tag.
 */
export async function tagOpenTickets(
  workspaceId: string,
  customerId: string | null,
  tag: string,
): Promise<void> {
  if (!customerId) return;
  const admin = createAdminClient();
  const { data: tickets } = await admin
    .from("tickets")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["open", "pending"]);
  if (!tickets?.length) return;
  const { addTicketTag } = await import("@/lib/ticket-tags");
  for (const t of tickets) await addTicketTag(t.id, tag);
}

/**
 * Cancel a subscription and send a payment-update email when a billing failure
 * carries a terminal error code AND the customer has no other payment methods
 * to rotate to. Skips the dunning cycle entirely — there's nothing to recover.
 *
 * Used by:
 *   - the billing-failure webhook handler (early path, before any cycle is created)
 *   - the dunning Inngest function (defensive fallback if it gets called anyway)
 */
export async function cancelForTerminalNoBackup(params: {
  workspaceId: string;
  contractId: string;
  customerId: string | null;
  errorCode: string;
  errorMessage: string | null;
  paymentMethodCount: number;
}): Promise<void> {
  const { workspaceId, contractId, customerId, errorCode, errorMessage, paymentMethodCount } = params;
  const admin = createAdminClient();
  const { appstleSubscriptionAction } = await import("@/lib/appstle");

  // Record an EXHAUSTED dunning cycle for this terminal cancel. The recovery flow
  // (reactivateDunningCancelledSubs) only reactivates + charges a cancelled sub
  // that has a cycle in [exhausted, cancelled] — so without this the recovery
  // email we send below promises a reactivation that can never happen (the sub is
  // cancelled, migrated on recovery, but never re-charged → no order).
  try {
    const { data: subRow } = await admin
      .from("subscriptions")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    const cyc = await createDunningCycle(workspaceId, contractId, (subRow?.id as string) ?? null, customerId, null);
    await updateDunningCycle(cyc.id, { status: "exhausted", terminal_error_code: errorCode });
  } catch (e) {
    console.error("[Dunning terminal-cancel] dunning cycle create failed:", e);
  }

  try {
    // Dynamic import: the SDK reaches back into this module via subscription-status-truth
    // (endDunningForSubscription), so a static import would close the cycle.
    const { subscriptionAction } = await import("@/lib/commerce/subscription");
    await subscriptionAction(
      workspaceId, contractId, "cancel", "dunning",
      `Cancelled by ShopCX — terminal billing error: ${errorCode} (${errorMessage || "no details"}), no other payment methods available`,
    );
  } catch (e) {
    console.error("[Dunning terminal-cancel] appstle cancel failed:", e);
  }

  // Magic-link recovery email + tagged closed ticket (replaces Appstle's
  // default + the old static portal URL).
  if (customerId) {
    try {
      const { sendPaymentRecoveryEmail } = await import("@/lib/payment-recovery-email");
      await sendPaymentRecoveryEmail(workspaceId, customerId);
    } catch (e) {
      console.error("[Dunning terminal-cancel] recovery email failed:", e);
    }
  }

  await postDunningNoteOnTicket(workspaceId, customerId, dunningInternalNote(
    `Terminal billing error: ${errorCode}. Customer has only ${paymentMethodCount} payment method(s). Subscription cancelled — exhausted dunning cycle recorded, so adding a working payment method will auto-reactivate + charge it.`
  ));
  await tagOpenTickets(workspaceId, customerId, "dunning:terminal");
}

/**
 * Roll a billing date forward by whole intervals until it lands in the FUTURE.
 *
 * ⚠️ Shopify rejects a past next-billing-date outright — both when creating a contract and when
 * setting the date on an existing one ("Next billing date is invalid", verified 2026-09-10; see
 * [[docs/brain/libraries/commerce__shopify-subscription-client]]).
 * Dunning routinely produces a past date: the exhaustion path computes
 * `original_billing_date + one interval`, and a cycle that ran for weeks lands before today.
 *
 * Rolling by WHOLE intervals (rather than clamping to "tomorrow") preserves the customer's cadence
 * anchor while guaranteeing a date Shopify will accept. Returns the base unchanged when it is
 * already in the future.
 *
 * ⚠️ Month-end anchors need care: naive `setMonth` OVERFLOWS — stepping from Jan 31 lands on Mar 3,
 * and the drift compounds every step (measured: 2026-01-31 → 2026-10-03). Days 1–28 are unaffected,
 * but 6 live monthly subs are anchored on day ≥ 29. We therefore remember the intended day-of-month
 * and clamp to the last day of the target month, so Jan 31 → Feb 28 → Mar 31 rather than sliding.
 */
export function rollForwardToFutureBillingDate(
  base: Date,
  interval: string,
  count: number,
  now: Date = new Date(),
): Date {
  const step = Math.max(1, count || 1);
  const unit = String(interval || "month").toLowerCase();
  const out = new Date(base);
  const anchorDay = base.getUTCDate();   // the day-of-month the customer is anchored to
  let months = 0;

  // Bounded: a malformed interval must not spin forever.
  for (let i = 0; i < 520 && out.getTime() <= now.getTime(); i++) {
    if (unit === "week") out.setUTCDate(out.getUTCDate() + 7 * step);
    else if (unit === "day") out.setUTCDate(out.getUTCDate() + step);
    else if (unit === "year") out.setUTCFullYear(out.getUTCFullYear() + step);
    else {
      // Month stepping from a fixed ORIGIN, clamped — never `setMonth` on a drifting value.
      months += step;
      const y = base.getUTCFullYear();
      const m = base.getUTCMonth() + months;
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      out.setUTCFullYear(y, m, Math.min(anchorDay, lastDay));
    }
  }

  // ⚠️ Post-condition. Hitting the iteration cap and returning a PAST date would be worse than
  // throwing: the caller writes it locally, Shopify rejects it, and the renewal cron then re-selects
  // that sub every day while never resolving a cycle — charged never, silently.
  if (out.getTime() <= now.getTime()) {
    throw new Error(
      `rollForwardToFutureBillingDate could not reach a future date from ${base.toISOString()} (${step} ${unit})`,
    );
  }
  return out;
}
