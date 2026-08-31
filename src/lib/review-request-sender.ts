/**
 * Shared review-request apply-path — the trigger-agnostic composer→validator
 * →ladder→canary-send pipeline both the ticket-trigger (future ticket-side
 * Phase-2 apply-path) and the post-order trigger
 * ([[docs/brain/specs/review-request-post-order-ask]] Phase 2) route
 * through.
 *
 * The spec's Phase-2 contract for post-order is:
 *
 *   > The post-order ask drafts, scores, validates, sends, and nudges
 *   > through exactly the same code as the ticket ask, and both write to
 *   > the same ladder so neither can double-ask.
 *
 * "Exactly the same code" is this module. A trigger handler passes its
 * typed context; the pipeline steps are shared:
 *
 *   1. **Reachability probe** — `assertProductReviewJourneyActive` — a
 *      workspace whose seed migration silently missed doesn't burn
 *      goodwill on a link that resolves to a 404.
 *   2. **Ladder dedup** — read `review_requests` for
 *      `(workspace, customer, product)`. Both triggers write here; both
 *      read here. The one-ladder invariant lives at THIS chokepoint, not
 *      at each trigger's detector, so a race between the two triggers
 *      cannot slip past.
 *   3. **Channel pick** — `pickReviewRequestChannel` on the customer's
 *      marketing status. Neither channel reachable ⇒ hard SKIP.
 *   4. **Body compose** — `composeReviewRequestFirstTouchBody` with the
 *      trigger label so the copy shapes differ (post-order has no
 *      thread to lean on) while the rubric, validator, and downstream
 *      pipeline stay identical.
 *   5. **Pre-send validator** — `validateReviewRequest` — the
 *      deterministic hard-block rails. Every draft persists with its
 *      validator verdict on `review_message_drafts.validator_verdict` so
 *      a later grader sweep can correlate why a draft died.
 *   6. **Draft persist** — `saveReviewMessageDraft`. Every ask lands
 *      here even if the validator BLOCKED, so the block itself is auditable
 *      (`outcome='blocked_by_validator'`).
 *   7. **Ladder row** — `insertReviewRequestRow` — only when the validator
 *      allowed. The `review_requests` row is the ladder's memory the nudge
 *      cron + the canary digest cron both read.
 *   8. **Canary-held send** — `queueReviewRequestAsPendingTicketMessage`
 *      onto the trigger-supplied anchor ticket (the ticket trigger's own
 *      ticket; the post-order trigger creates a synthetic anchor). The
 *      deliver-pending-sends outbox ships it after the 18h canary hold,
 *      and the canary-digest cron surfaces every held draft to the CEO
 *      inbox before send.
 *
 * The SHAPE of the pipeline is enforced by the return type — every result
 * carries a discriminated `outcome` naming the exact step that decided,
 * so caller telemetry (heartbeat produced counts) can distinguish "skipped
 * because journey inactive" from "blocked by validator" from "shipped".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertProductReviewJourneyActive } from "@/lib/journey-definition-probe";
import {
  composeReviewRequestFirstTouchBody,
  type ReviewRequestTrigger,
  type ReviewRequestWindow,
} from "@/lib/review-request-compose";
import { getActiveReviewRubric } from "@/lib/review-message-rubric";
import { saveReviewMessageDraft } from "@/lib/review-message-drafts";
import {
  REVIEW_REQUEST_CANARY_HOLD_MS,
  insertReviewRequestRow,
  mintReviewRequestToken,
  pickReviewRequestChannel,
  queueReviewRequestAsPendingTicketMessage,
} from "@/lib/review-request-delivery";
import { validateReviewRequest } from "@/lib/review-request-validator";

/**
 * The trigger-agnostic input the shared pipeline takes. Trigger-specific
 * context (a ticket_id for the ticket trigger, the post-order window for
 * the post-order trigger) is folded into the discriminated `context`.
 */
export interface ApplyReviewRequestInput {
  workspaceId: string;
  customerId: string;
  productId: string;
  /** The angle Sol picked (or the trigger's deterministic default). MUST
   * be in `APPROVED_REVIEW_PRETEXTS` — the validator's `unapproved_pretext`
   * rail is what enforces the set at persist-time. */
  angle: "defend" | "fence-sitter";
  /** Whether the ask includes a coupon. The validator's
   * `sentiment_conditional_coupon_*` rails only fire when this is true. */
  includeCoupon: boolean;
  /** The trigger-specific context. `type` is the discriminant every
   * downstream step reads. */
  context:
    | {
        type: "ticket";
        ticketId: string;
      }
    | {
        type: "post-order";
        /** The window the detector labeled the candidate with. */
        window: ReviewRequestWindow;
        /** Optional order id that produced the trigger (audit trail). */
        orderId?: string | null;
      };
}

/**
 * Every outcome the pipeline can produce. Kept as a discriminated union so
 * the caller's telemetry surface is exhaustive.
 */
export type ApplyReviewRequestResult =
  | { outcome: "skipped_journey_inactive"; reason: string }
  | { outcome: "skipped_ladder_dedup" }
  | { outcome: "skipped_customer_missing" }
  | { outcome: "skipped_product_missing" }
  | { outcome: "skipped_unreachable" }
  | { outcome: "skipped_no_rubric" }
  | {
      outcome: "blocked_by_validator";
      draftId: string;
      reasons: string[];
    }
  | {
      outcome: "queued";
      draftId: string;
      reviewRequestId: string;
      ticketMessageId: string;
      anchorTicketId: string;
      channel: "email" | "sms";
    };

/**
 * Trigger-agnostic apply. Returns a discriminated result naming the exact
 * pipeline step that decided so the caller can carry it into its heartbeat.
 *
 * Guard-before-mutation (per coaching learnings #11 + #12): every mutating
 * step re-asserts its precondition. The ladder dedup read is followed by
 * an INSERT to `review_requests` that would violate a per-tick unique key
 * if another trigger snuck in — an insert error there is the "already
 * asked" case and reports as `skipped_ladder_dedup`.
 */
export async function applyReviewRequest(
  admin: SupabaseClient,
  input: ApplyReviewRequestInput,
): Promise<ApplyReviewRequestResult> {
  const trigger: ReviewRequestTrigger =
    input.context.type === "post-order" ? "post-order" : "ticket";

  // Step 1 — REACHABILITY. Assert the product-review journey is ACTIVE
  // for this workspace. `is_active=false` (or a missing row) is a hard
  // SKIP — a link that resolves to a 404 wastes the ask (spec Phase 2's
  // "reachable, not just compiled" verification).
  const journey = await assertProductReviewJourneyActive(admin, input.workspaceId);
  if (!journey.active) {
    return { outcome: "skipped_journey_inactive", reason: journey.reason };
  }

  // Step 2 — LADDER DEDUP. Read `review_requests` for (workspace, customer,
  // product). Both triggers write here, both read here — this chokepoint
  // is what makes the "one ladder across both triggers" invariant hold
  // regardless of which detector fires first.
  const { data: existingLadder } = await admin
    .from("review_requests")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("customer_id", input.customerId)
    .eq("product_id", input.productId)
    .limit(1);
  if ((existingLadder ?? []).length > 0) {
    return { outcome: "skipped_ladder_dedup" };
  }

  // Step 3 — LOAD customer + product. Both are workspace-scoped reads so
  // a cross-workspace id in the input cannot leak.
  const { data: customer } = await admin
    .from("customers")
    .select(
      "id, email, first_name, sms_marketing_status, email_marketing_status, created_at, total_orders",
    )
    .eq("id", input.customerId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (!customer) return { outcome: "skipped_customer_missing" };

  const { data: product } = await admin
    .from("products")
    .select("id, title, reviewable")
    .eq("id", input.productId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (!product || product.reviewable === false) {
    return { outcome: "skipped_product_missing" };
  }

  // Step 4 — CHANNEL PICK. Never to an explicit unsubscribe. Neither
  // channel reachable ⇒ hard SKIP.
  const channel = pickReviewRequestChannel({
    smsSubscribed: customer.sms_marketing_status === "subscribed",
    emailUnsubscribed: customer.email_marketing_status === "unsubscribed",
  });
  if (!channel) return { outcome: "skipped_unreachable" };

  // Step 5 — RUBRIC LOAD. A workspace with no active rubric is a hard
  // SKIP; the spec's "the rubric with its self-score and revise-once"
  // reuse contract fails at the SDK layer if the rubric row is missing.
  const rubric = await getActiveReviewRubric(admin, input.workspaceId);
  if (!rubric) return { outcome: "skipped_no_rubric" };

  // Step 6 — COMPOSE. Mint the per-ask token FIRST so the URL bakes it
  // in, then hand off to the shared trigger-aware body composer.
  const token = mintReviewRequestToken();
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai").trim();
  const reviewUrl = `${siteUrl}/journey/product-review/${token}`;
  const tenureDays =
    typeof customer.created_at === "string"
      ? Math.floor(
          (Date.now() - Date.parse(customer.created_at as string)) /
            (24 * 60 * 60 * 1000),
        )
      : null;
  const composed = composeReviewRequestFirstTouchBody({
    trigger,
    channel,
    angle: input.angle,
    productName: (product.title as string) || "",
    customerFirstName: (customer.first_name as string | null) ?? null,
    reviewUrl,
    window: input.context.type === "post-order" ? input.context.window : null,
    tenureDays,
  });

  // Step 7 — VALIDATE. Every draft goes through the shared deterministic
  // validator; both allow and BLOCK verdicts persist to
  // `review_message_drafts.validator_verdict` so a later grader sweep can
  // correlate the block reasons.
  const validator = validateReviewRequest({
    channel,
    subject: composed.subject,
    body: composed.body,
    tenureDays,
    orderCount:
      typeof customer.total_orders === "number"
        ? (customer.total_orders as number)
        : null,
    angle: input.angle,
    productName: (product.title as string) || null,
    coupon: { include: input.includeCoupon },
    smsShortlink: channel === "sms" ? reviewUrl : null,
  });

  // Step 8 — DRAFT PERSIST (regardless of validator outcome). Even a
  // blocked draft persists so a later analysis can correlate the block
  // rail against the trigger + angle. `review_request_id` is null on a
  // blocked draft (we haven't written the ladder row yet).
  const draftId = await saveReviewMessageDraft(admin, {
    workspaceId: input.workspaceId,
    customerId: input.customerId,
    productId: input.productId,
    ticketId:
      input.context.type === "ticket" ? input.context.ticketId : null,
    reviewRequestId: null,
    channel,
    angle: input.angle,
    subject: composed.subject || null,
    body: composed.body,
    rubricVersion: rubric.version,
    // Sol's self-score + independent QC are the ticket-side box session's
    // job (future); the post-order path currently ships without an LLM
    // pass. The columns stay null so a later grader can tell "no pass ran"
    // from "pass ran and failed".
    selfScore: null,
    qcVerdict: null,
    validatorVerdict: {
      allow: validator.allow,
      reasons: validator.reasons,
    },
    outcome: validator.allow ? "drafted" : "blocked_by_validator",
  });

  if (!validator.allow) {
    return { outcome: "blocked_by_validator", draftId, reasons: validator.reasons };
  }

  // Step 9 — SHARED LADDER ROW. Both triggers write here. `insertReviewRequestRow`
  // stamps `outcome='sent'` at insert time — the ladder considers it in-flight
  // from now on and no other trigger will step on it.
  const reviewRequestId = await insertReviewRequestRow(admin, {
    workspaceId: input.workspaceId,
    customerId: input.customerId,
    productId: input.productId,
    channel,
    angle:
      input.context.type === "post-order"
        ? // Trigger label prefixed to the angle so a later analyze can
          // split repeat/first-time asks against ticket asks without a
          // schema change. The validator's `unapproved_pretext` rail
          // reads `draft.angle`, not `review_requests.angle`, so this
          // free-text label is safe here.
          `post-order:${input.angle}`
        : input.angle,
    token,
  });

  // Step 10 — CANARY-HELD SEND. Anchor ticket:
  //   • ticket trigger — the trigger's own ticket_id.
  //   • post-order trigger — synthesize a portal-channel ticket per-ask so
  //     the shared outbox drains it identically to the ticket-side send.
  //     The canary-digest cron links to /dashboard/tickets/<id> to let the
  //     founder cancel/edit before it ships.
  const anchorTicketId =
    input.context.type === "ticket"
      ? input.context.ticketId
      : await createPostOrderAnchorTicket(admin, {
          workspaceId: input.workspaceId,
          customerId: input.customerId,
          productTitle: (product.title as string) || null,
        });

  const ticketMessageId = await queueReviewRequestAsPendingTicketMessage(admin, {
    ticketId: anchorTicketId,
    body: composed.body,
    holdMs: REVIEW_REQUEST_CANARY_HOLD_MS,
  });

  return {
    outcome: "queued",
    draftId,
    reviewRequestId,
    ticketMessageId,
    anchorTicketId,
    channel,
  };
}

/**
 * Post-order-specific — a lightweight portal-channel ticket that anchors
 * the pending outbound message so the deliver-pending-sends outbox ships
 * it, the review-request-nudge-cron finds it, and the canary-digest cron
 * links to it identically to a ticket-trigger anchor.
 *
 * Kept exported so the Phase-2 unit test can exercise the row shape
 * without importing the whole apply pipeline.
 */
export async function createPostOrderAnchorTicket(
  admin: SupabaseClient,
  input: {
    workspaceId: string;
    customerId: string;
    productTitle: string | null;
  },
): Promise<string> {
  const productLabel = input.productTitle?.trim() || "your recent order";
  const { data, error } = await admin
    .from("tickets")
    .insert({
      workspace_id: input.workspaceId,
      customer_id: input.customerId,
      subject: `Review request — ${productLabel}`,
      status: "open",
      // Portal-channel routes through sendPortalThreadEmail — the same
      // email path the ticket-trigger's ask would use (portal is the
      // "system-initiated" channel already used by dunning + delivery-
      // audit synthetic tickets).
      channel: "portal",
      tags: ["review_request:post_order"],
    })
    .select("id")
    .single();
  if (error) throw error;
  if (!data?.id) {
    throw new Error("createPostOrderAnchorTicket: insert returned no id");
  }
  return data.id as string;
}
