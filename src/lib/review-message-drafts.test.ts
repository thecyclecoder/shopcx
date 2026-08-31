/**
 * Unit tests for the pure half of the review-message-drafts SDK
 * (Phase 2 of review-request-sol-session). `buildDraftInsert` is the shape
 * guard that catches a malformed caller BEFORE it reaches Supabase, so
 * every named rejection has a test that pins the exact throw path.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildDraftInsert,
  type ReviewMessageDraftInput,
} from "./review-message-drafts";

const goodInput: ReviewMessageDraftInput = {
  workspaceId: "10000000-0000-0000-0000-000000000000",
  customerId: "20000000-0000-0000-0000-000000000000",
  productId: "30000000-0000-0000-0000-000000000000",
  ticketId: "40000000-0000-0000-0000-000000000000",
  reviewRequestId: null,
  channel: "email",
  angle: "fence-sitter",
  subject: "quick question",
  body: "share a line about the Sleep Gummies?",
  rubricVersion: 1,
  selfScore: { total: 88, per_criterion: { ask_is_question: 15 }, revision_count: 0 },
  qcVerdict: { verdict: "pass", reasons: [], reasoning: "reads clean" },
  validatorVerdict: { allow: true, reasons: [] },
};

test("buildDraftInsert — the well-formed input round-trips 1:1", () => {
  const row = buildDraftInsert(goodInput);
  assert.equal(row.workspace_id, goodInput.workspaceId);
  assert.equal(row.customer_id, goodInput.customerId);
  assert.equal(row.channel, "email");
  assert.equal(row.angle, "fence-sitter");
  assert.equal(row.rubric_version, 1);
  assert.equal(row.outcome, "drafted"); // default
});

test("buildDraftInsert — an explicit outcome overrides the default", () => {
  const row = buildDraftInsert({ ...goodInput, outcome: "sent" });
  assert.equal(row.outcome, "sent");
});

test("buildDraftInsert — trims a whitespace outcome to the default", () => {
  const row = buildDraftInsert({ ...goodInput, outcome: "   " });
  assert.equal(row.outcome, "drafted");
});

test("buildDraftInsert — rejects null/non-object input", () => {
  assert.throws(
    () => buildDraftInsert(null as unknown as ReviewMessageDraftInput),
    /not an object/,
  );
});

test("buildDraftInsert — rejects a missing workspaceId", () => {
  assert.throws(
    () => buildDraftInsert({ ...goodInput, workspaceId: "" }),
    /workspaceId/,
  );
});

test("buildDraftInsert — rejects a missing customerId", () => {
  assert.throws(
    () => buildDraftInsert({ ...goodInput, customerId: "" }),
    /customerId/,
  );
});

test("buildDraftInsert — rejects an unknown channel", () => {
  assert.throws(
    () =>
      buildDraftInsert({
        ...goodInput,
        channel: "mail" as unknown as "email",
      }),
    /channel/,
  );
});

test("buildDraftInsert — rejects an unknown angle", () => {
  assert.throws(
    () =>
      buildDraftInsert({
        ...goodInput,
        angle: "urgency" as unknown as "defend",
      }),
    /angle/,
  );
});

test("buildDraftInsert — rejects a whitespace-only body", () => {
  assert.throws(
    () => buildDraftInsert({ ...goodInput, body: "   " }),
    /body/,
  );
});

test("buildDraftInsert — passes through nullable columns as null", () => {
  const row = buildDraftInsert({
    ...goodInput,
    productId: null,
    ticketId: null,
    reviewRequestId: null,
    subject: null,
    rubricVersion: null,
    selfScore: null,
    qcVerdict: null,
    validatorVerdict: null,
  });
  assert.equal(row.product_id, null);
  assert.equal(row.ticket_id, null);
  assert.equal(row.review_request_id, null);
  assert.equal(row.subject, null);
  assert.equal(row.rubric_version, null);
  assert.equal(row.self_score, null);
  assert.equal(row.qc_verdict, null);
  assert.equal(row.validator_verdict, null);
});
