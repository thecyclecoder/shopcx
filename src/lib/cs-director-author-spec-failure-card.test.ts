/**
 * Unit tests for `buildAuthorSpecFailureCard` — the pure builder used by
 * `runCsDirectorCallJob` (scripts/builder-worker.ts) to mint the CEO inbox card for a FAILED
 * `author_spec` verdict (june-authored-specs-carry-machine-runnable-checks Phase 2). Mirrors
 * `cs-director-escalate-founder-card.test.ts` on shape + surface conventions.
 *
 * Verification bullets (Phase 2):
 *  - A failed author_spec yields a CEO-routed `agent_approval_request` card so the founder sees
 *    the failure instead of it dead-ending on a parked agent_job (Yvonne Carreon 2.6-day gap).
 *  - The card body carries the intended spec (slug + title), June's reasoning ("Diagnosis:"), and
 *    the concrete failure line so the founder can author the spec by hand OR treat it as a bug in
 *    the author path itself.
 *  - The spec_seed persists on metadata verbatim so a downstream approver / bounce-back handler
 *    can pick it up structurally without re-parsing the body.
 *  - A missing/empty spec_seed still yields a coherent card (never a bare surface).
 *  - The failure branch is grep-able from `metadata.failure_reason` (spec_seed_missing_* /
 *    ticket_id_unresolved / author_spec_write_returned_false / author_spec_threw / handler_threw).
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/cs-director-author-spec-failure-card.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthorSpecFailureCard, summarizeIntendedSpec } from "./cs-director-author-spec-failure-card";

test("every author_spec failure yields a CEO-routed agent_approval_request card shape", () => {
  const row = buildAuthorSpecFailureCard({
    ticketId: "ticket-abc-123",
    reasoning: "Repeat-coupon tickets keep drifting past the analyzer.",
    jobId: "job-xyz-456",
    failureReason: "author_spec_threw",
    failureError: "author_spec: SDK threw (MissingMachineCheckError) — no spec written",
    specSeed: {
      slug: "cs-analyzer-coupon-gap",
      title: "Analyzer routes repeat-coupon tickets to remedy",
      intent: "Route repeat-coupon tickets to the remedy path.",
      problem: "The analyzer skipped remedy path on repeat coupon.",
    },
  });
  assert.equal(row.metadata.routed_to_function, "ceo", "routes to the CEO seat");
  assert.equal(row.metadata.escalation_kind, "cs_director_author_spec_failed");
  assert.equal(row.metadata.raised_by_function, "cs");
  assert.equal(row.metadata.escalated_by_director, "cs");
  assert.equal(row.metadata.ticket_id, "ticket-abc-123");
  assert.equal(row.metadata.cs_director_call_job_id, "job-xyz-456");
  assert.equal(row.metadata.agent_job_id, "job-xyz-456", "so buildApprovalsFeed can join to the job row");
  assert.equal(row.link, "/dashboard/tickets/ticket-abc-123");
});

test("card body carries the intended spec + Diagnosis + Failure lines so the founder acts without opening the ticket", () => {
  const row = buildAuthorSpecFailureCard({
    ticketId: "t-1",
    reasoning: "Repeat-coupon tickets drift past the analyzer.",
    jobId: "j-1",
    failureReason: "author_spec_write_returned_false",
    failureError: "author_spec: SDK returned false for slug=cs-analyzer-coupon-gap",
    specSeed: {
      slug: "cs-analyzer-coupon-gap",
      title: "Analyzer routes repeat-coupon tickets to remedy",
    },
  });
  assert.match(row.body, /Intended spec: cs-analyzer-coupon-gap — Analyzer routes repeat-coupon tickets to remedy/);
  assert.match(row.body, /Diagnosis: Repeat-coupon tickets drift past the analyzer\./);
  assert.match(row.body, /Failure \(author_spec_write_returned_false\): author_spec: SDK returned false/);
});

test("metadata carries spec_seed verbatim so a downstream approver can pick it up structurally", () => {
  const seed = {
    slug: "cs-analyzer-coupon-gap",
    title: "T",
    intent: "I",
    problem: "P",
    target: "src/lib/ticket-analyzer.ts",
  };
  const row = buildAuthorSpecFailureCard({
    ticketId: "t-1",
    reasoning: "x",
    jobId: "j-1",
    failureReason: "author_spec_threw",
    failureError: "SDK threw",
    specSeed: seed,
  });
  assert.deepEqual(row.metadata.spec_seed, seed, "seed carried through unmodified");
  assert.equal(row.metadata.failure_reason, "author_spec_threw");
  assert.equal(row.metadata.failure_error, "SDK threw");
});

test("a missing spec_seed still yields a coherent card (never a bare surface)", () => {
  const row = buildAuthorSpecFailureCard({
    ticketId: "t-1",
    reasoning: "reason line",
    jobId: "j-1",
    failureReason: "spec_seed_missing",
    failureError: null,
    specSeed: null,
  });
  assert.match(row.body, /Intended spec: \(none — the spec_seed itself was missing\/malformed on the verdict\)/);
  assert.match(row.body, /Diagnosis: reason line/);
  assert.match(row.body, /Failure: spec_seed_missing/);
  assert.equal(row.metadata.spec_seed, null, "seed persists as null (not omitted) so absent ≠ unread");
  assert.equal(row.metadata.failure_error, null, "empty error persists as null (not omitted)");
});

test("empty reasoning is normalized so the mint never silently produces a bare card", () => {
  const row = buildAuthorSpecFailureCard({
    ticketId: "t-1",
    reasoning: "   ",
    jobId: "j-1",
    failureReason: "handler_threw",
    specSeed: { slug: "cs-x", title: "X" },
  });
  assert.match(row.body, /Diagnosis: \(no reasoning recorded\)/);
});

test("failure_reason is preserved verbatim so a grep on the metadata surface classifies the branch", () => {
  const branches = [
    "spec_seed_missing",
    "spec_seed_missing_slug",
    "spec_seed_missing_title",
    "spec_seed_missing_intent",
    "spec_seed_missing_problem",
    "spec_seed_slug_empties_after_normalize",
    "ticket_id_unresolved",
    "author_spec_write_returned_false",
    "author_spec_threw",
    "handler_threw",
  ];
  for (const branch of branches) {
    const row = buildAuthorSpecFailureCard({
      ticketId: "t-1",
      reasoning: "r",
      jobId: "j-1",
      failureReason: branch,
      specSeed: null,
    });
    assert.equal(row.metadata.failure_reason, branch, `branch ${branch} preserved on metadata`);
    assert.match(row.metadata.escalation_reason, new RegExp(`author_spec FAILED \\(${branch}\\)`));
  }
});

test("title is a founder-facing chip flagging the failure class (not a generic 'needs human review')", () => {
  const row = buildAuthorSpecFailureCard({
    ticketId: "t-1",
    reasoning: "x",
    jobId: "j-1",
    failureReason: "author_spec_threw",
    specSeed: null,
  });
  assert.match(row.title, /CS Director — author_spec FAILED/);
  assert.match(row.title, /needs founder review/);
  assert.ok(row.title.length <= 200, "title stays within notification-title cap");
});

test("summarizeIntendedSpec renders slug + title, either alone, or names the seed as absent", () => {
  assert.equal(
    summarizeIntendedSpec({ slug: "cs-x", title: "X" }),
    "cs-x — X",
  );
  assert.equal(summarizeIntendedSpec({ slug: "cs-x" }), "cs-x");
  assert.equal(summarizeIntendedSpec({ title: "X" }), "X");
  assert.equal(
    summarizeIntendedSpec(null),
    "(none — the spec_seed itself was missing/malformed on the verdict)",
  );
  assert.equal(
    summarizeIntendedSpec({}),
    "(none — the spec_seed carried no slug/title)",
  );
});
