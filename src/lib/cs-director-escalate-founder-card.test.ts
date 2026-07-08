/**
 * Unit tests for `buildEscalateFounderCard` — the pure builder used by
 * `runCsDirectorCallJob` (scripts/builder-worker.ts) to mint the CEO inbox card for every
 * `escalate_founder` verdict. Mirrors the sibling `cs-director-verdict-note.test.ts` pattern.
 *
 * Verification (each bullet mirrors the spec's Phase-1 Verification block):
 *   - EVERY escalate_founder verdict yields a card shape with type-ready fields
 *     (title/body/link/metadata) — no branch swallows the mint.
 *   - metadata.routed_to_function === 'ceo' → the row lands in `buildApprovalsFeed`'s escalated set
 *     (approvals-feed.ts:220 reads `.eq("type", "agent_approval_request")` + routed_to_function).
 *   - The card body carries June's reasoning (Phase 1's "referencing June's reasoning" contract).
 *   - The link deep-links to /dashboard/tickets/<ticket_id> so the CEO can open the ticket in one tap.
 *   - Metadata carries the ticket + cs_director_call_job_id back-pointers so the audit trail joins.
 *   - Empty reasoning is normalized so the mint never silently produces a bare card.
 *   - Black-swan classification threads through when present, and stays absent when not.
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/cs-director-escalate-founder-card.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildEscalateFounderCard } from "./cs-director-escalate-founder-card";

test("every escalate_founder verdict yields a CEO-routed agent_approval_request card shape", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-abc-123",
    reasoning: "Grandfathered subscription renewed at the new $59.90 price instead of the $33.01 lock — customer was overcharged $26.89 and disputes the last two renewals.",
    jobId: "job-xyz-456",
  });
  assert.equal(row.metadata.routed_to_function, "ceo", "routes to the CEO seat");
  assert.equal(row.metadata.escalation_kind, "cs_director_escalate_founder");
  assert.equal(row.metadata.raised_by_function, "cs");
  assert.equal(row.metadata.escalated_by_director, "cs");
  assert.equal(row.metadata.ticket_id, "ticket-abc-123");
  assert.equal(row.metadata.cs_director_call_job_id, "job-xyz-456");
  assert.equal(row.metadata.agent_job_id, "job-xyz-456", "so buildApprovalsFeed can join to the job row");
});

test("card body carries June's reasoning so the CEO reads the finding without re-investigating", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Refund past ceiling with a billable card — needs CEO ruling before we move.",
    jobId: "job-1",
  });
  assert.match(row.body, /Refund past ceiling with a billable card/);
  assert.match(row.metadata.escalation_reason, /Refund past ceiling with a billable card/);
});

test("deep link points to the ticket so the CEO can open it in one tap", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-abc-123",
    reasoning: "Some finding.",
    jobId: "job-1",
  });
  assert.equal(row.link, "/dashboard/tickets/ticket-abc-123");
  assert.equal(row.metadata.deep_link, "/dashboard/tickets/ticket-abc-123");
});

test("triage_run_id + black-swan classification thread through when present", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Fraud ring detected — chargebacks on 8 cards in the same 24h window.",
    jobId: "job-1",
    triageRunId: "triage-run-1",
    blackSwanClass: "fraud_alert",
    blackSwanSource: "keyword_default",
  });
  assert.equal(row.metadata.triage_run_id, "triage-run-1");
  assert.equal(row.metadata.black_swan_class, "fraud_alert");
  assert.equal(row.metadata.black_swan_source, "keyword_default");
  assert.match(row.title, /\(fraud_alert\)/, "the class labels the card title so the CEO can scan the feed");
});

test("no triage_run / no black-swan classification leaves those metadata slots explicitly null", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "A regular hard-call — no black-swan class.",
    jobId: "job-1",
  });
  assert.equal(row.metadata.triage_run_id, null);
  assert.equal(row.metadata.black_swan_class, null);
  assert.equal(row.metadata.black_swan_source, null);
  assert.equal(row.title, "CS Director — escalate to founder", "no class → no title suffix");
});

test("empty reasoning is normalized so the card never silently ships bare", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "",
    jobId: "job-1",
  });
  assert.match(row.body, /no reasoning recorded/);
  assert.match(row.metadata.escalation_reason, /no reasoning recorded/);
});

test("reasoning longer than 4000 chars is trimmed on body (2000 on escalation_reason) — never dropped, never overflowed", () => {
  const long = "x".repeat(5000);
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: long,
    jobId: "job-1",
  });
  assert.equal(row.body.length, 4000);
  assert.equal(row.metadata.escalation_reason.length, 2000);
});

test("black-swan class of 'unspecified' does NOT badge the title (a bare `black_swan:true` flag with no named class)", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Something urgent but the class isn't named.",
    jobId: "job-1",
    blackSwanClass: "unspecified",
    blackSwanSource: "verdict_metadata",
  });
  assert.equal(row.title, "CS Director — escalate to founder", "unspecified class does not badge the title");
  assert.equal(row.metadata.black_swan_class, "unspecified", "but the class is still carried in metadata for the audit");
});
