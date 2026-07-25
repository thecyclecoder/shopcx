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

test("close_no_action verdict writes a no-op note (handled correctly, no remedy, no founder page)", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "close_no_action",
    reasoning: "Phantom $236.50 charge — no such order on this customer or any linked identity; AI already asked for the order number.",
  });
  assert.match(note, /Decision: close_no_action/);
  assert.match(note, /Phantom \$236\.50 charge/);
  assert.match(note, /No action needed/);
  assert.match(note, /no founder page/i);
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

// ── Phase 3 of escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation ──
// The note surfaces the Phase-2 `recommended_remedy` when June names one on an escalate_founder
// verdict, so the ticket thread carries the SAME diagnosis + recommendation the CEO card carries.
// A CS agent reading the ticket sees the concrete recommended action, not just the reasoning.

test("Phase 3 — escalate_founder note surfaces June's recommended_remedy when present so ticket thread matches the CEO card", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "escalate_founder",
    reasoning: "Grandfathered sub renewed at the new $59.90 price instead of the $33.01 lock — overcharged $26.89 on the 2026-06-24 renewal.",
    recommended_remedy: {
      kind: "refund_and_price_lock",
      summary: "Refund $26.89 for the incorrect renewal + restore the $33.01 grandfathered price lock before the next renewal.",
    },
  });
  assert.match(note, /Decision: escalate_founder/);
  assert.match(note, /Escalated to CEO for hard call:/);
  assert.match(note, /Recommended remedy \(refund_and_price_lock\): Refund \$26\.89/);
});

test("Phase 3 — escalate_founder note without a recommended_remedy stays back-compatible (Phase 1 shape)", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "escalate_founder",
    reasoning: "Non-binary judgment call — the policy call is CEO's.",
  });
  assert.match(note, /Decision: escalate_founder/);
  assert.match(note, /Escalated to CEO for hard call:/);
  assert.doesNotMatch(note, /Recommended remedy:/, "no recommendation → the note is silent on it (Phase 1 shape)");
});

test("Phase 3 — escalate_founder with a summary-only recommended_remedy still surfaces it as the summary", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "escalate_founder",
    reasoning: "Something specific.",
    recommended_remedy: { summary: "Comp a full month + escalate to the fulfillment vendor about the repeated delay." },
  });
  assert.match(note, /Recommended remedy: Comp a full month/);
});

test("Phase 3 — escalate_founder with an empty recommended_remedy object is treated as no recommendation, not a bare fallback", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "escalate_founder",
    reasoning: "Something specific.",
    recommended_remedy: {},
  });
  assert.doesNotMatch(note, /Recommended remedy:/, "empty object == no recommendation, note stays quiet");
});

// ── Phase 1 of cs-director-spec-claim-must-match-the-actual-write ──
// The audit-visible receipt must name what the specs SDK actually wrote — never what June claimed.
// On ticket 2b7ea029 the pre-Phase-1 builder rendered `Authored spec: {slug}` off `verdict.spec_seed`
// though no `director_activity` row existed and no spec landed. These tests prove the note now
// consults the author OUTCOME threaded through from `handleAuthorSpec`.

test("Phase 1 — confirmed write: note renders the slug the SDK actually landed (from author_outcome), not June's seed slug", () => {
  // The specs SDK normalized the seed slug from the LLM's proposal to a shorter form — the note
  // MUST name the slug that actually landed, not the pre-normalization seed. This is the exact
  // handler-vs-claim divergence the spec's Phase 1 calls out (cs-director.ts line ~125).
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Analyzer never routed repeat-coupon tickets to the remedy path.",
    spec_seed: {
      slug: "cs-analyzer-original-june-proposed-slug",
      title: "Analyzer routes repeat-coupon tickets to the remedy path",
    },
    author_outcome: {
      ok: true,
      spec_slug: "cs-analyzer-normalized-slug",
    },
  });
  assert.match(note, /Decision: author_spec/);
  assert.match(note, /Authored spec: cs-analyzer-normalized-slug/);
  assert.doesNotMatch(note, /cs-analyzer-original-june-proposed-slug/, "the LLM's claim slug must not leak into the receipt");
});

test("Phase 1 — confirmed write with matching seed: note surfaces slug + title exactly like the legacy shape", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Analyzer gap.",
    spec_seed: {
      slug: "cs-analyzer-coupon-routing-gap",
      title: "Analyzer routes repeat-coupon tickets to the remedy path",
    },
    author_outcome: {
      ok: true,
      spec_slug: "cs-analyzer-coupon-routing-gap",
    },
  });
  assert.match(note, /Authored spec: cs-analyzer-coupon-routing-gap — "Analyzer routes repeat-coupon tickets to the remedy path"/);
});

test("Phase 1 — failed write (author_spec_write_returned_false): note renders explicit FAILED line naming the reason, never a slug", () => {
  // The exact regression from ticket 2b7ea029 — the SDK's chokepoint guard rejected the write, so
  // the note must not read as if the spec landed. The reason names the concrete failure class so a
  // CS agent glancing at the thread can trace what went wrong.
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Bug identified, structural fix needed.",
    spec_seed: {
      slug: "appstle-discount-replace-atomic-and-preserve-manual-discounts",
      title: "Preserve manual discounts across Appstle discount replace",
    },
    author_outcome: {
      ok: false,
      reason: "author_spec_write_returned_false",
    },
  });
  assert.match(note, /Decision: author_spec/);
  assert.match(note, /author_spec FAILED \(author_spec_write_returned_false\) — no spec was written/);
  assert.doesNotMatch(note, /appstle-discount-replace-atomic-and-preserve-manual-discounts/, "the phantom slug must NOT appear on a failed write");
  assert.doesNotMatch(note, /^Authored spec:/m, "the confirmed-write line must not render on a failed write");
});

test("Phase 1 — failed write with spec_seed_missing_slug reason renders the same explicit FAILED line", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Bug identified.",
    spec_seed: { title: "just a title" },
    author_outcome: { ok: false, reason: "spec_seed_missing_slug" },
  });
  assert.match(note, /author_spec FAILED \(spec_seed_missing_slug\) — no spec was written/);
});

test("Phase 1 — failed write with ticket_id_unresolved reason (Derived-from linkage would be blank)", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Bug identified.",
    spec_seed: { slug: "some-slug", title: "some title" },
    author_outcome: { ok: false, reason: "ticket_id_unresolved" },
  });
  assert.match(note, /author_spec FAILED \(ticket_id_unresolved\) — no spec was written/);
  assert.doesNotMatch(note, /Authored spec: some-slug/);
});

test("Phase 1 — failed write with author_spec_threw reason (SDK threw)", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Bug identified.",
    spec_seed: { slug: "some-slug", title: "some title" },
    author_outcome: { ok: false, reason: "author_spec_threw" },
  });
  assert.match(note, /author_spec FAILED \(author_spec_threw\) — no spec was written/);
});

test("Phase 1 — failed write with an empty reason string still renders a FAILED line (fallback reason token)", () => {
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Bug identified.",
    spec_seed: { slug: "some-slug" },
    author_outcome: { ok: false, reason: "" },
  });
  assert.match(note, /author_spec FAILED \(unknown_reason\) — no spec was written/);
});

test("Phase 1 — missing author_outcome (legacy caller) falls back to the claim-only line — back-compat shape", () => {
  // A stale caller that omits `author_outcome` still gets a rendered note (the claim-only line);
  // this is the exact back-compat behavior every pre-Phase-1 test in this file exercises. The
  // shipped call site in builder-worker.ts ALWAYS threads the outcome — this path exists only for
  // callers that predate the outcome argument.
  const note = buildCsDirectorVerdictNote({
    decision: "author_spec",
    reasoning: "Bug identified.",
    spec_seed: { slug: "legacy-slug" },
  });
  assert.match(note, /Authored spec: legacy-slug/);
});
