/**
 * Unit tests for `buildCsDirectorVerdictNote` — the pure body builder used by
 * `runCsDirectorCallJob` (scripts/builder-worker.ts) to write the per-verdict internal note that
 * closes Phase 1 of the loop-closure spec.
 *
 * Verification (each bullet mirrors the spec's Phase-1 Verification block):
 *   - author_spec  → note names June + decision + reasoning + the authored spec slug
 *   - approve_remedy → note names June + decision + reasoning + a remedy summary
 *   - escalate_founder → note names June + decision + reasoning + the founder-escalation reason
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/cs-director-verdict-note.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCsDirectorVerdictNote } from "./cs-director-verdict-note";

test("author_spec verdict writes note naming June, decision, reasoning, and spec slug", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Two prior turns proposed the same coupon and the analyzer never routed to remedy — an analyzer gap the customer-side patch cannot close.",
    spec_seed: {
      slug: "cs-analyzer-coupon-routing-gap",
      title: "Analyzer routes repeat-coupon tickets to the remedy path",
      intent: "route",
      problem: "repeat coupon",
    },
  });
  assert.match(note, /June \(CS Director\)/);
  assert.match(note, /Decision: author_spec/);
  assert.match(note, /Two prior turns proposed the same coupon/);
  assert.match(note, /cs-analyzer-coupon-routing-gap/);
  assert.match(note, /Analyzer routes repeat-coupon tickets to the remedy path/);
});

test("approve_remedy verdict writes note naming June, decision, reasoning, and remedy summary", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "approve_remedy",
    reasoning: "Customer's dispute is a shipping-carrier lost package + card on file is billable — refund is in leash.",
    remedy: {
      kind: "refund_order",
      summary: "Full refund on order superfoods_123 — carrier confirmed lost, in leash of the CS refund ceiling.",
    },
  });
  assert.match(note, /June \(CS Director\)/);
  assert.match(note, /Decision: approve_remedy/);
  assert.match(note, /Customer's dispute is a shipping-carrier lost package/);
  assert.match(note, /Full refund on order superfoods_123/);
  assert.match(note, /refund_order/);
});

test("escalate_founder verdict writes note naming June, decision, reasoning, and founder-escalation reason", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "escalate_founder",
    reasoning: "Multiple large chargebacks on the same card in the last 24h look like a fraud ring — needs a CEO ruling before any customer-side action.",
  });
  assert.match(note, /June \(CS Director\)/);
  assert.match(note, /Decision: escalate_founder/);
  assert.match(note, /Multiple large chargebacks/);
  assert.match(note, /Escalated to CEO for hard call:/);
});

test("empty reasoning is normalized so the note still records the decision", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "",
    spec_seed: { slug: "slug-without-title" },
  });
  assert.match(note, /Decision: author_spec/);
  assert.match(note, /no reasoning recorded/);
  assert.match(note, /slug-without-title/);
});

test("author_spec with missing spec_seed still records the decision + falls back gracefully", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Placeholder reasoning.",
    spec_seed: null,
  });
  assert.match(note, /Decision: author_spec/);
  assert.match(note, /slug missing/);
});

test("approve_remedy with an empty remedy object records a graceful fallback line", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "approve_remedy",
    reasoning: "Approved.",
    remedy: {},
  });
  assert.match(note, /Decision: approve_remedy/);
  assert.match(note, /see director_activity for the RemedyPlan/);
});
