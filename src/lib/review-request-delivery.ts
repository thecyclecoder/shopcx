/**
 * Review-request delivery SDK (Phase 3 of review-request-sol-session).
 *
 * The Phase-2 rubric + validator + drafts persistence sits upstream of the
 * customer send. Phase 3 is what actually ships the ask — one journey per
 * ask (a double-click cannot double-issue a coupon), one nudge if the
 * customer doesn't respond, one canary hold that goes through the existing
 * `ticket_messages.pending_send_at` outbox (not a bespoke sender) so the
 * ticket UI's "Sending at {time} · Cancel" behaviour applies for free.
 *
 * Design contract — every ask lives on ONE row in [[review_requests]] with a
 * per-ask token. SMS + email + the nudge all point at the SAME token, so:
 *   • the token is minted once when Sol decides;
 *   • the click-handler resolves the token to the same ask regardless of
 *     channel — the same `journey_sessions` materializes on first click and
 *     is reused across the SMS-then-email double-tap;
 *   • the nudge suppresses itself when the ask's `outcome` is already
 *     `submitted` / `routed_to_cs` / the customer replied to the thread.
 *
 * This module is split into a PURE half (predicates + token mint + channel
 * pick) and a live half (the DB helpers that mint one ask, queue a pending
 * ticket message, mark a nudge fired). The pure half is unit-tested in
 * isolation; the live half is small enough to exercise via a test-harness
 * pattern the surrounding Inngest crons already use.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

export type ReviewRequestChannel = "email" | "sms";
export type ReviewRequestAngle = "defend" | "fence-sitter";

/** The lifecycle marker `review_requests.outcome` can carry — text so a future
 * outcome is a data change, not a migration. Readers probe actual values. */
export const REVIEW_REQUEST_OUTCOMES = [
  "sent",
  "clicked",
  "submitted",
  "routed_to_cs",
  "expired",
] as const;
export type ReviewRequestOutcome = (typeof REVIEW_REQUEST_OUTCOMES)[number];

/** Nudge cadence — the spec pins 3-4 days after the first-touch. We schedule
 * at 3 days sharp and let the cron sweep any candidate whose window opened. */
export const REVIEW_REQUEST_NUDGE_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

/** Canary hold — the spec pins a LONG pending_send_at (12-24h) so the CEO
 * inbox digest has time to raise. We schedule at 18h — well inside the range
 * and past overnight batching. */
export const REVIEW_REQUEST_CANARY_HOLD_MS = 18 * 60 * 60 * 1000;

/**
 * Mint a per-ask token — the shared identifier every channel's URL carries.
 * A double-click across SMS + email resolves to the SAME token and therefore
 * the SAME journey_sessions row when the handler materializes one; the nudge
 * suppresses on the same token. 24 hex chars = 96 bits of entropy — same
 * shape [[csat-token]] uses; enough for uniqueness at the workspace scale
 * without a collision-check read.
 */
export function mintReviewRequestToken(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Route the ask to a channel. SMS when the customer has SMS-subscribed
 * (opt-in only — a review request is close enough to marketing that TCPA
 * exposure isn't worth 4,115 extra recipients per the spec's numbers).
 * Otherwise email — but NEVER to an explicit unsubscribe.
 *
 * Returns null when NEITHER channel is reachable — a customer who has
 * unsubscribed from both is a clean skip (nothing to send is always
 * correct).
 *
 * Pure: unit-tested in isolation without a Supabase client.
 */
export function pickReviewRequestChannel(input: {
  smsSubscribed: boolean;
  emailUnsubscribed: boolean;
}): ReviewRequestChannel | null {
  if (input.smsSubscribed) return "sms";
  if (input.emailUnsubscribed) return null;
  return "email";
}

/**
 * The nudge-suppression predicate — the spec's Phase 3 § "The nudge —
 * exactly one" list, encoded verbatim. Returns `true` when the nudge MUST
 * suppress. Every reason string is a stable name so a caller can log the
 * exact rail that fired.
 *
 * Suppression conditions (any one → suppress):
 *   • the ask's outcome is `submitted` — the customer already reviewed;
 *   • the ask's outcome is `routed_to_cs` — the low-star path already
 *     opened a CS ticket, don't compound;
 *   • the ask's outcome is `expired` — the window closed;
 *   • the ask's outcome is `clicked` — the customer opened the link and
 *     the journey took over (a click is a positive signal a nudge would
 *     read as "we didn't notice");
 *   • the customer already replied inbound to the thread — a nudge on top
 *     of a paragraph reply reads as "we didn't notice you";
 *   • the customer unsubscribed since the ask went out;
 *   • the ask has already been nudged (one nudge maximum per ask).
 *
 * Pure — safe to unit-test.
 */
export function shouldSuppressReviewRequestNudge(input: {
  outcome: string | null;
  nudgedAt: string | null;
  customerRepliedAfterSent: boolean;
  customerUnsubscribed: boolean;
}): { suppress: boolean; reason: string | null } {
  if (input.nudgedAt) {
    return { suppress: true, reason: "already_nudged" };
  }
  const oc = String(input.outcome ?? "");
  if (oc === "submitted") return { suppress: true, reason: "outcome_submitted" };
  if (oc === "routed_to_cs") return { suppress: true, reason: "outcome_routed_to_cs" };
  if (oc === "expired") return { suppress: true, reason: "outcome_expired" };
  if (oc === "clicked") return { suppress: true, reason: "outcome_clicked" };
  if (input.customerRepliedAfterSent) {
    return { suppress: true, reason: "customer_replied" };
  }
  if (input.customerUnsubscribed) {
    return { suppress: true, reason: "customer_unsubscribed" };
  }
  return { suppress: false, reason: null };
}

/**
 * Is a review_request row inside its 3-4d nudge window? Pure — safe to
 * unit-test. Returns true when the ask was sent ≥ 3 days ago; the spec's
 * "3-4 days" ceiling is enforced by the cron's cadence (the next tick after
 * 3 days catches it).
 */
export function isReviewRequestReadyForNudge(input: {
  sentAt: string | null;
  now: number;
}): boolean {
  if (!input.sentAt) return false;
  const t = Date.parse(input.sentAt);
  if (Number.isNaN(t)) return false;
  return input.now - t >= REVIEW_REQUEST_NUDGE_DELAY_MS;
}

/**
 * Insert one `review_requests` row for the ask. The row is written when the
 * ask is SENT (not when the customer submits) so the ladder's dedupe read
 * (has this customer been asked?) works before any click. Returns the new
 * row's id or throws.
 *
 * A per-ask token is generated here — Phase 3's URL composer bakes it into
 * every channel's link so a double-tap resolves to the SAME journey session
 * on click.
 *
 * Compare-and-set safety — the insert asserts the (workspace_id, customer_id,
 * product_id, angle) shape the ladder deduplicates against. A caller that
 * hits a UNIQUE-index violation is the "already asked" case; we let the
 * error bubble so the cron's per-tick guard can log and skip.
 */
export interface InsertReviewRequestInput {
  workspaceId: string;
  customerId: string;
  productId: string;
  channel: ReviewRequestChannel;
  angle: string;
  token: string;
  /** Optional — drives per-flavour imagery on the review page when known. */
  variantId?: string | null;
}

/** Slug of the journey definition every review session belongs to. */
export const REVIEW_JOURNEY_SLUG = "product-review";

/**
 * How long a minted review link stays usable. The nudge fires at 3 days, so the
 * window has to comfortably outlive it; 30 days matches the other tokenized
 * journeys in the table.
 */
export const REVIEW_REQUEST_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Create the `journey_sessions` row the magic link resolves against.
 *
 * ⚠️ This is the fix for the 2026-09-08 dead-link outage. `insertReviewRequestRow`
 * REQUIRED a token (it threw without one) and then never persisted it anywhere —
 * no session row, no column on `review_requests`. So every minted
 * `/review/{token}` link resolved to `loadReviewSessionByToken` →
 * `journey_sessions.token = …` → no row → 404 `session_not_found`. 439 delivered
 * asks plus 341 nudges all pointed at a dead page, which is exactly why the
 * response rate was 0.00% rather than merely low.
 *
 * The code comments described the session as materializing "on first click", but
 * nothing implemented that and the loader is a plain SELECT. Minting at SEND time
 * is the simpler contract: we already hold workspace, customer, product and token
 * at that moment, and the link is verifiable the instant it goes out.
 *
 * `status: 'pending'` is deliberate — `loadReviewSessionByToken` refuses
 * `completed`, and the submit path moves the row forward itself.
 */
export async function createReviewJourneySession(
  admin: SupabaseClient,
  input: {
    workspaceId: string;
    customerId: string;
    productId: string;
    token: string;
    variantId?: string | null;
    ttlMs?: number;
  },
): Promise<string> {
  const { data: journey, error: jErr } = await admin
    .from("journey_definitions")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("slug", REVIEW_JOURNEY_SLUG)
    .maybeSingle();
  if (jErr) throw jErr;
  if (!journey?.id) {
    throw new Error(`createReviewJourneySession: no '${REVIEW_JOURNEY_SLUG}' journey definition for workspace ${input.workspaceId}`);
  }

  const ttl = typeof input.ttlMs === "number" && input.ttlMs > 0 ? input.ttlMs : REVIEW_REQUEST_TOKEN_TTL_MS;
  const { data, error } = await admin
    .from("journey_sessions")
    .insert({
      workspace_id: input.workspaceId,
      journey_id: journey.id as string,
      customer_id: input.customerId,
      product_id: input.productId,
      variant_id: input.variantId ?? null,
      token: input.token,
      token_expires_at: new Date(Date.now() + ttl).toISOString(),
      status: "pending",
      current_step: 0,
      responses: {},
      config_snapshot: {
        journeyType: "product_review",
        codeDriven: true,
        workspaceId: input.workspaceId,
        productId: input.productId,
      },
    })
    .select("id")
    .single();
  if (error) throw error;
  if (!data?.id) throw new Error("createReviewJourneySession: insert returned no id");
  return data.id as string;
}

/**
 * Write the ladder row AND the session its link resolves against, then join them.
 *
 * The session comes FIRST on purpose: if it fails we throw before a
 * `review_requests` row exists, so the sender aborts and no customer receives a
 * link that cannot work. The previous order of operations had no session at all,
 * which is the bug this replaces — a row that claims `outcome='sent'` while the
 * link behind it 404s is worse than no row.
 */
export async function insertReviewRequestRow(
  admin: SupabaseClient,
  input: InsertReviewRequestInput,
): Promise<string> {
  if (!input.workspaceId) throw new Error("insertReviewRequestRow: missing workspaceId");
  if (!input.customerId) throw new Error("insertReviewRequestRow: missing customerId");
  if (!input.productId) throw new Error("insertReviewRequestRow: missing productId");
  if (!input.token) throw new Error("insertReviewRequestRow: missing token");

  const journeySessionId = await createReviewJourneySession(admin, {
    workspaceId: input.workspaceId,
    customerId: input.customerId,
    productId: input.productId,
    token: input.token,
    variantId: input.variantId ?? null,
  });

  const { data, error } = await admin
    .from("review_requests")
    .insert({
      workspace_id: input.workspaceId,
      customer_id: input.customerId,
      product_id: input.productId,
      channel: input.channel,
      angle: input.angle,
      outcome: "sent",
      journey_session_id: journeySessionId,
    })
    .select("id")
    .single();
  if (error) throw error;
  if (!data?.id) throw new Error("insertReviewRequestRow: insert returned no id");
  return data.id as string;
}

/**
 * Queue an outbound review-request message as a CANARY-HELD pending
 * ticket_message — reuses the deliver-pending-sends outbox (every 5 min)
 * for the send, so the ticket UI's "Sending at {time} · Cancel" behaviour
 * applies for free AND a customer inbound before the send auto-cancels
 * via the outbox's newer-inbound guard. The spec's "canary drafts hold as
 * pending ticket messages" verification bullet is this call site.
 *
 * `holdMs` defaults to REVIEW_REQUEST_CANARY_HOLD_MS (18h) while the canary
 * flag is on. Phase-3 spec: "canary off is a config flag, not a rewrite:
 * the delay drops to the normal response delay and the digest stops."
 */
export interface QueueReviewRequestMessageInput {
  ticketId: string;
  body: string;
  holdMs?: number;
}
export async function queueReviewRequestAsPendingTicketMessage(
  admin: SupabaseClient,
  input: QueueReviewRequestMessageInput,
): Promise<string> {
  if (!input.ticketId) {
    throw new Error("queueReviewRequestAsPendingTicketMessage: missing ticketId");
  }
  if (!input.body?.trim()) {
    throw new Error("queueReviewRequestAsPendingTicketMessage: missing body");
  }
  const holdMs =
    typeof input.holdMs === "number" && input.holdMs >= 0
      ? input.holdMs
      : REVIEW_REQUEST_CANARY_HOLD_MS;
  const pendingAt = new Date(Date.now() + holdMs).toISOString();
  const { data, error } = await admin
    .from("ticket_messages")
    .insert({
      ticket_id: input.ticketId,
      direction: "outbound",
      visibility: "external",
      author_type: "ai",
      body: input.body,
      pending_send_at: pendingAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  if (!data?.id) {
    throw new Error("queueReviewRequestAsPendingTicketMessage: insert returned no id");
  }
  return data.id as string;
}

/**
 * Mark an ask's nudge as FIRED — a compare-and-set write that only lands
 * when `nudged_at` is still null. Returns true when we transitioned exactly
 * one row (safe to proceed with the send), false when we lost the race (a
 * concurrent tick already claimed the nudge). Callers MUST short-circuit
 * on false — a double-nudge would be a hard user-visible regression.
 *
 * The guard-before-mutation pattern the coaching learnings pin: never trust
 * a coarse read to authorize an authoritative write; the write itself
 * re-asserts the precondition.
 */
export async function markReviewRequestNudgeFired(
  admin: SupabaseClient,
  reviewRequestId: string,
): Promise<boolean> {
  if (!reviewRequestId) return false;
  const { data, error } = await admin
    .from("review_requests")
    .update({ nudged_at: new Date().toISOString() })
    .eq("id", reviewRequestId)
    .is("nudged_at", null)
    .select("id");
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}
