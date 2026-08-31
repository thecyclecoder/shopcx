/**
 * Review-message-drafts SDK (Phase 2 of review-request-sol-session).
 *
 * Every drafted review-request message persists with its rubric self-score,
 * independent-QC verdict, deterministic-validator verdict, and eventual
 * outcome so a later grader sweep can correlate rubric scores against real
 * response rates and tune the rubric on evidence instead of taste. See
 * [[docs/brain/tables/review_message_drafts]] + [[review-message-rubric]].
 *
 * This module is intentionally split into two halves:
 *
 *   • `buildDraftInsert` — PURE, no DB dependency. Turns the caller's typed
 *     bag into the row shape the `review_message_drafts.insert(...)` call
 *     takes. Unit-tested in isolation without Supabase.
 *
 *   • `saveReviewMessageDraft` — the live persister. Wraps
 *     `buildDraftInsert` around a `.from("review_message_drafts").insert()`
 *     + `.select("id").single()` — returns the new row's id or throws.
 *
 * Every row is authored by the WORKER (deterministic Node — Phase 3's send
 * path). Sol NEVER writes to this table directly; her verdict flows THROUGH
 * the worker, which composes the row and calls this SDK.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ReviewMessageChannel = "email" | "sms";
export type ReviewMessageAngle = "defend" | "fence-sitter";

/** The self-score bag persisted alongside the draft. */
export interface ReviewMessageSelfScore {
  total: number;
  per_criterion: Record<string, number>;
  revision_count: number;
}

/** The independent-QC verdict persisted alongside the draft. */
export interface ReviewMessageQcVerdict {
  verdict: "pass" | "fail";
  reasons: string[];
  reasoning: string;
}

/** The deterministic pre-send validator verdict persisted alongside the draft. */
export interface ReviewMessageValidatorVerdict {
  allow: boolean;
  reasons: string[];
}

/** The typed bag the caller hands `buildDraftInsert` / `saveReviewMessageDraft`. */
export interface ReviewMessageDraftInput {
  workspaceId: string;
  customerId: string;
  productId: string | null;
  ticketId: string | null;
  reviewRequestId: string | null;
  channel: ReviewMessageChannel;
  angle: ReviewMessageAngle;
  subject: string | null;
  body: string;
  rubricVersion: number | null;
  selfScore: ReviewMessageSelfScore | null;
  qcVerdict: ReviewMessageQcVerdict | null;
  validatorVerdict: ReviewMessageValidatorVerdict | null;
  /** Lifecycle marker — defaults to 'drafted'. */
  outcome?: string;
}

/** The insert-row shape — matches the migration's column set 1:1. */
export interface ReviewMessageDraftInsertRow {
  workspace_id: string;
  customer_id: string;
  product_id: string | null;
  ticket_id: string | null;
  review_request_id: string | null;
  channel: ReviewMessageChannel;
  angle: ReviewMessageAngle;
  subject: string | null;
  body: string;
  rubric_version: number | null;
  self_score: ReviewMessageSelfScore | null;
  qc_verdict: ReviewMessageQcVerdict | null;
  validator_verdict: ReviewMessageValidatorVerdict | null;
  outcome: string;
}

/**
 * Pure — turn the typed input bag into the shape `insert()` accepts. Throws
 * a named error on any structural miss so a malformed caller doesn't reach
 * Supabase with an invalid row.
 */
export function buildDraftInsert(
  input: ReviewMessageDraftInput,
): ReviewMessageDraftInsertRow {
  if (!input || typeof input !== "object") {
    throw new Error("buildDraftInsert: input is not an object");
  }
  if (!input.workspaceId) {
    throw new Error("buildDraftInsert: missing workspaceId");
  }
  if (!input.customerId) {
    throw new Error("buildDraftInsert: missing customerId");
  }
  if (input.channel !== "email" && input.channel !== "sms") {
    throw new Error("buildDraftInsert: channel must be 'email' or 'sms'");
  }
  if (input.angle !== "defend" && input.angle !== "fence-sitter") {
    throw new Error("buildDraftInsert: angle must be 'defend' or 'fence-sitter'");
  }
  if (typeof input.body !== "string" || !input.body.trim()) {
    throw new Error("buildDraftInsert: body must be a non-empty string");
  }
  const outcome = input.outcome && input.outcome.trim() ? input.outcome.trim() : "drafted";
  return {
    workspace_id: input.workspaceId,
    customer_id: input.customerId,
    product_id: input.productId,
    ticket_id: input.ticketId,
    review_request_id: input.reviewRequestId,
    channel: input.channel,
    angle: input.angle,
    subject: input.subject,
    body: input.body,
    rubric_version: input.rubricVersion,
    self_score: input.selfScore,
    qc_verdict: input.qcVerdict,
    validator_verdict: input.validatorVerdict,
    outcome,
  };
}

/**
 * Live persister — insert one drafted row and return its id. Throws on the
 * Supabase error verbatim so the caller can surface a diagnosable failure.
 */
export async function saveReviewMessageDraft(
  admin: SupabaseClient,
  input: ReviewMessageDraftInput,
): Promise<string> {
  const row = buildDraftInsert(input);
  const { data, error } = await admin
    .from("review_message_drafts")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  if (!data?.id) {
    throw new Error("saveReviewMessageDraft: insert returned no id");
  }
  return data.id as string;
}
