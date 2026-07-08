/**
 * Unit tests for `buildEscalateFounderCard` — the pure builder used by
 * `runCsDirectorCallJob` (scripts/builder-worker.ts) to mint the CEO inbox card for every
 * `escalate_founder` verdict. Mirrors the sibling `cs-director-verdict-note.test.ts` pattern.
 *
 * Verification bullets:
 *   Phase 1 —
 *   - EVERY escalate_founder verdict yields a card shape with type-ready fields
 *     (title/body/link/metadata) — no branch swallows the mint.
 *   - metadata.routed_to_function === 'ceo' → the row lands in `buildApprovalsFeed`'s escalated set
 *     (approvals-feed.ts:220 reads `.eq("type", "agent_approval_request")` + routed_to_function).
 *   - The card body carries June's reasoning (Phase 1's "referencing June's reasoning" contract).
 *   - The link deep-links to /dashboard/tickets/<ticket_id> so the CEO can open the ticket in one tap.
 *   - Metadata carries the ticket + cs_director_call_job_id back-pointers so the audit trail joins.
 *   - Empty reasoning is normalized so the mint never silently produces a bare card.
 *   - Black-swan classification threads through when present, and stays absent when not.
 *   Phase 2 —
 *   - The card body carries a `Diagnosis:` line quoting June's reasoning + a `Recommended remedy:`
 *     line quoting the recommendation, so the CEO reads the concrete finding + the suggested action
 *     in one glance (never a bare "needs human review").
 *   - The recommended remedy is carried on metadata.recommended_remedy so a downstream approver /
 *     bounce-back handler can pick it up structurally.
 *   - When June does NOT provide a recommendation, the card still cites the diagnosis (Phase 1
 *     back-compat) with a "Recommended remedy: (none — CEO to decide the action)" fallback so the
 *     shape stays consistent and the card is never bare.
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

// ── Phase 2 — diagnosis + recommended remedy on the card body ─────────────────────────────────

test("Phase 2 — card body labels the diagnosis (June's reasoning) explicitly so the CEO reads the concrete finding", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Grandfathered subscription renewed at the new $59.90 price instead of the $33.01 lock — customer was overcharged $26.89 on the 2026-06-24 renewal and disputes the last two.",
    jobId: "job-1",
  });
  assert.match(row.body, /Diagnosis:\s+/, "body carries a labeled Diagnosis line");
  assert.match(row.body, /overcharged \$26\.89/, "the diagnosis quotes the concrete finding");
});

test("Phase 2 — card body names a recommended remedy when June provides one", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Grandfathered sub overcharged $26.89 on the 2026-06-24 renewal — needs CEO ruling.",
    jobId: "job-1",
    recommendedRemedy: {
      kind: "refund_and_price_lock",
      summary: "Refund $26.89 for the incorrect renewal + restore the $33.01 grandfathered price lock on the sub before the next renewal.",
    },
  });
  assert.match(row.body, /Recommended remedy:\s+/, "body carries a labeled Recommended remedy line");
  assert.match(row.body, /Refund \$26\.89/, "the remedy quotes the concrete recommendation");
  assert.match(row.body, /refund_and_price_lock/, "the remedy kind is surfaced for the CEO to see the shape");
  assert.deepEqual(
    row.metadata.recommended_remedy,
    { kind: "refund_and_price_lock", summary: "Refund $26.89 for the incorrect renewal + restore the $33.01 grandfathered price lock on the sub before the next renewal." },
    "the recommendation is carried structurally on metadata so a downstream handler can pick it up",
  );
});

test("Phase 2 — verification: the CEO card names the concrete issue and a recommended remedy; it is not a bare 'needs human review'", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Chargeback dispute on a legitimate order — customer claims fraud, our fraud tools show no risk. In CS refund ceiling territory but the storyline is non-binary.",
    jobId: "job-1",
    recommendedRemedy: {
      kind: "refund_full_order",
      summary: "Refund the full $89.94 order — CS ceiling covers it, but wanted a CEO sign-off given the fraud claim.",
    },
  });
  assert.doesNotMatch(row.body, /needs human review/i, "not a bare fallback string");
  assert.match(row.body, /Diagnosis:\s+.*chargeback dispute/i, "names the concrete issue");
  assert.match(row.body, /Recommended remedy:\s+.*refund the full \$89\.94/i, "names a recommended remedy");
});

test("Phase 2 — no recommendation falls back to an explicit 'CEO to decide' line, still cites the diagnosis, still not bare", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Non-binary judgment call — customer wants a partial refund + a policy change; the policy call is CEO's, not mine.",
    jobId: "job-1",
  });
  assert.match(row.body, /Diagnosis:\s+.*non-binary judgment call/i, "diagnosis still present");
  assert.match(row.body, /Recommended remedy:\s+\(none — CEO to decide the action\)/, "explicit no-recommendation fallback");
  assert.doesNotMatch(row.body, /needs human review/i);
  assert.equal(row.metadata.recommended_remedy, null, "metadata carries null (not omitted) so downstream can distinguish absent vs unread");
});

test("Phase 2 — recommendation with only a summary (no kind) still surfaces on the card", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Something specific.",
    jobId: "job-1",
    recommendedRemedy: {
      summary: "Comp a full month + escalate to the fulfillment vendor about the repeated delay.",
    },
  });
  assert.match(row.body, /Recommended remedy:\s+.*Comp a full month/i);
});

test("Phase 2 — recommendation with only a kind (no summary) still surfaces on the card as the kind", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Something specific.",
    jobId: "job-1",
    recommendedRemedy: { kind: "refund_order" },
  });
  assert.match(row.body, /Recommended remedy:\s+refund_order/);
});

test("Phase 2 — empty/malformed recommendation object (no kind + no summary) falls back to the 'CEO to decide' line, not a bare '(kind unknown)'", () => {
  const row = buildEscalateFounderCard({
    ticketId: "ticket-1",
    reasoning: "Something specific.",
    jobId: "job-1",
    recommendedRemedy: {},
  });
  assert.match(row.body, /Recommended remedy:\s+\(none — CEO to decide the action\)/);
});
