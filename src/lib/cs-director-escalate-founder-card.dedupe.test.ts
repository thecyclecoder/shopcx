/**
 * CEO-inbox signal-to-noise hot fix (2026-08-11) — pins the one-open-card-per-ticket key on June's founder
 * escalation.
 *
 * Regression this guards: the card carried `ticket_id` (the natural incident key) but NO
 * `dedupe_key`, so it sat outside the `dashboard_notifications_dedupe_key_open_uniq` partial index
 * entirely. The founder-escalation-stale-recheck cron re-enqueues a fresh `cs-director-call` every
 * STALE_FOUNDER_ESCALATION_HOURS for an unactioned ticket, so ONE unresolved ticket minted a new
 * CEO card every 48h. On 2026-08-11 the same customer's already-settled refund question held two
 * cards (16h and 18h old).
 *
 *   npx tsx --test src/lib/cs-director-escalate-founder-card.dedupe.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildEscalateFounderCard, escalateFounderDedupeKey } from "./cs-director-escalate-founder-card";

const base = {
  ticketId: "11111111-2222-3333-4444-555555555555",
  reasoning: "Refund is settled; the residue is a policy question only the founder can answer.",
  jobId: "job-1",
  triageRunId: null,
  blackSwanClass: null,
  blackSwanSource: null,
  recommendedRemedy: null,
  partialRemedyOutcome: null,
};

test("escalateFounderDedupeKey — keyed on the TICKET, not the job", () => {
  assert.equal(escalateFounderDedupeKey(base.ticketId), `cs-director-founder:${base.ticketId}`);
});

test("the card carries a dedupe_key so the DB's open-card unique index can see it", () => {
  const row = buildEscalateFounderCard(base);
  assert.equal(row.metadata.dedupe_key, escalateFounderDedupeKey(base.ticketId));
});

test("a 48h stale-recheck re-run of the SAME ticket produces the SAME key (one open decision)", () => {
  // The recheck mints a new cs-director-call, so jobId differs and the reasoning is re-written —
  // neither may change the key, or the founder gets a second card for one decision.
  const first = buildEscalateFounderCard(base);
  const recheck = buildEscalateFounderCard({
    ...base,
    jobId: "job-2-from-the-48h-recheck",
    reasoning: "Re-checked 48h later: still a founder call.",
    triageRunId: "triage-9",
  });
  assert.equal(recheck.metadata.dedupe_key, first.metadata.dedupe_key);
});

test("a DIFFERENT ticket gets a different key (never collapses two customers' decisions)", () => {
  const other = buildEscalateFounderCard({ ...base, ticketId: "99999999-8888-7777-6666-555555555555" });
  assert.notEqual(other.metadata.dedupe_key, buildEscalateFounderCard(base).metadata.dedupe_key);
});
