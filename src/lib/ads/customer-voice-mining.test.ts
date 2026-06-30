/**
 * Unit tests for the customer-voice mining reader (growth-customer-voice-to-ad-angles, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:customer-voice-mining
 *   (= tsx --test src/lib/ads/customer-voice-mining.test.ts)
 *
 * Covers the spec's verification:
 *   fixture rows from each source produce the expected fragments labeled positive/objection/use_case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mineCustomerVoice,
  synthesizeAdAngles,
  buildProposedAngleRows,
  type AngleCandidateRaw,
  type SynthesizeAngleLLM,
  type VoiceFragment,
} from "./customer-voice-mining";
import type { PatternMatrix } from "@/lib/creative-skeleton";

interface FakeTableRow {
  data: unknown;
  error: null;
}

// A chainable thenable that ignores filter args — the mined fragments are produced by `mineCustomerVoice`'s
// own JS-side filtering and shaping, so the mock just hands back the table's stock fixture.
function makeChain(result: FakeTableRow) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.is = () => chain;
  chain.not = () => chain;
  chain.gte = () => chain;
  chain.then = (onFulfilled: (v: FakeTableRow) => unknown) => Promise.resolve(result).then(onFulfilled);
  return chain;
}

function makeAdmin(tables: Record<string, FakeTableRow>) {
  return {
    from(table: string) {
      const result = tables[table] ?? { data: [], error: null };
      return makeChain(result);
    },
  } as unknown as Parameters<typeof mineCustomerVoice>[0];
}

test("each source produces a fragment with the right signal label", async () => {
  // One review, one cancel event, one ticket (no analysis row) → 3 fragments, one per signal.
  const admin = makeAdmin({
    product_reviews: {
      data: [
        { id: "r1", body: "I sleep through the night now — the sun-dried chlorella actually works.", smart_quote: null, rating: 5 },
      ],
      error: null,
    },
    customer_events: {
      data: [
        { id: "ce1", summary: "Cancel reason selected: too expensive", properties: { reason: "too_expensive", reasonLabel: "Too expensive" } },
      ],
      error: null,
    },
    tickets: {
      data: [{ id: "t1", subject: "How do I take this with coffee?" }],
      error: null,
    },
    ticket_analyses: { data: [], error: null },
  });

  const { fragments } = await mineCustomerVoice(admin, {
    workspaceId: "ws-1",
    productId: "p-coffee",
  });

  assert.equal(fragments.length, 3);

  const review = fragments.find((f) => f.source === "product_reviews");
  assert.ok(review);
  assert.equal(review!.signal, "positive");
  assert.equal(review!.source_id, "r1");
  assert.equal(review!.text, "I sleep through the night now — the sun-dried chlorella actually works.");

  const cancel = fragments.find((f) => f.source === "customer_events");
  assert.ok(cancel);
  assert.equal(cancel!.signal, "objection");
  assert.equal(cancel!.source_id, "ce1");
  // Prefer the human-readable `reasonLabel` over the slug.
  assert.equal(cancel!.text, "Too expensive");

  const ticket = fragments.find((f) => f.source === "tickets");
  assert.ok(ticket);
  assert.equal(ticket!.signal, "use_case");
  assert.equal(ticket!.source_id, "t1");
  assert.equal(ticket!.text, "How do I take this with coffee?");
});

test("smart_quote wins over body for review text", async () => {
  // Reviews have a Klaviyo-extracted highlight (≤15 words). When present we prefer it — that's the
  // bit closest to ad copy. The body is the fallback.
  const admin = makeAdmin({
    product_reviews: {
      data: [
        { id: "r2", body: "Long-winded body about my whole life story and how chlorella has changed it.", smart_quote: "Chlorella changed how I sleep.", rating: 4 },
      ],
      error: null,
    },
    customer_events: { data: [], error: null },
    tickets: { data: [], error: null },
    ticket_analyses: { data: [], error: null },
  });

  const { fragments } = await mineCustomerVoice(admin, { workspaceId: "ws", productId: "p" });
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].text, "Chlorella changed how I sleep.");
});

test("ticket_analyses summary wins over ticket subject", async () => {
  // The AI summary is higher signal than the subject — use it as the fragment text when present.
  const admin = makeAdmin({
    product_reviews: { data: [], error: null },
    customer_events: { data: [], error: null },
    tickets: {
      data: [{ id: "t-a", subject: "Question" }],
      error: null,
    },
    ticket_analyses: {
      data: [{ ticket_id: "t-a", summary: "Customer asks if Superfoods is safe during pregnancy.", created_at: "2026-06-29T10:00:00Z" }],
      error: null,
    },
  });

  const { fragments } = await mineCustomerVoice(admin, { workspaceId: "ws", productId: "p" });
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].source, "tickets");
  assert.equal(fragments[0].text, "Customer asks if Superfoods is safe during pregnancy.");
});

test("cancel reason falls back through reasonLabel → reason → parsed summary", async () => {
  // Three rows: one with reasonLabel, one with only reason slug, one with neither but a summary.
  const admin = makeAdmin({
    product_reviews: { data: [], error: null },
    customer_events: {
      data: [
        { id: "ce-label", summary: "Cancel reason selected: Doesn't work", properties: { reason: "no_results", reasonLabel: "Doesn't work" } },
        { id: "ce-slug", summary: null, properties: { reason: "too_expensive" } },
        { id: "ce-sum", summary: "Cancel reason selected: Forgot to skip", properties: null },
      ],
      error: null,
    },
    tickets: { data: [], error: null },
    ticket_analyses: { data: [], error: null },
  });

  const { fragments } = await mineCustomerVoice(admin, { workspaceId: "ws", productId: "p" });
  assert.equal(fragments.length, 3);
  const byId = new Map(fragments.map((f) => [f.source_id, f.text]));
  assert.equal(byId.get("ce-label"), "Doesn't work");
  assert.equal(byId.get("ce-slug"), "too_expensive");
  assert.equal(byId.get("ce-sum"), "Forgot to skip");
});

test("rows that would yield empty text are dropped", async () => {
  // A review with no body and no smart_quote (the .not('body', 'is', null) DB filter would normally
  // exclude this, but we belt-and-suspenders the JS side too), a cancel event with empty properties
  // and no summary, and a ticket with an empty subject — all should be filtered out.
  const admin = makeAdmin({
    product_reviews: {
      data: [{ id: "r-empty", body: "   ", smart_quote: null, rating: 5 }],
      error: null,
    },
    customer_events: {
      data: [{ id: "ce-empty", summary: null, properties: {} }],
      error: null,
    },
    tickets: {
      data: [{ id: "t-empty", subject: "  " }],
      error: null,
    },
    ticket_analyses: { data: [], error: null },
  });

  const { fragments } = await mineCustomerVoice(admin, { workspaceId: "ws", productId: "p" });
  assert.equal(fragments.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — synthesizeAdAngles
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_FRAGMENTS: VoiceFragment[] = [
  { source: "product_reviews", source_id: "r1", text: "Clean energy without jitters — finally.", signal: "positive" },
  { source: "product_reviews", source_id: "r2", text: "I sleep deeper since starting Superfoods.", signal: "positive" },
  { source: "customer_events", source_id: "ce1", text: "Too expensive", signal: "objection" },
  { source: "tickets", source_id: "t1", text: "Can I take this with coffee?", signal: "use_case" },
];

const FIXTURE_MATRIX: PatternMatrix = {
  generatedFrom: 12,
  brandCount: 4,
  slotPatterns: [
    { slot: "hook", label: "wake up tired", brandCount: 3, brands: ["a", "b", "c"], maxDaysRunning: 90, exampleValues: ["wake up tired daily"] },
    { slot: "mechanism_claim", label: "clean energy no jitters", brandCount: 4, brands: ["a", "b", "c", "d"], maxDaysRunning: 120, exampleValues: ["clean energy no jitters"] },
    { slot: "proof", label: "3000 reviews", brandCount: 2, brands: ["a", "b"], maxDaysRunning: 60, exampleValues: ["3000 reviews"] },
    { slot: "offer", label: "subscribe and save", brandCount: 2, brands: ["a", "b"], maxDaysRunning: 60, exampleValues: ["subscribe and save"] },
  ],
  testMatrix: [],
};

function stubLLM(candidates: AngleCandidateRaw[]): SynthesizeAngleLLM {
  return async () => ({ candidates });
}

test("synthesizeAdAngles produces exactly K typed candidates with non-zero score", async () => {
  // The spec's verification: stubbed LLM emits K candidates → all return with
  // non-zero scores. Each candidate must cite at least one real fragment id.
  const llm = stubLLM([
    {
      hook: "Wake up tired? Stop blaming sleep.",
      mechanism_claim: "Clean energy no jitters",
      proof: "3000 reviews",
      offer: "Subscribe and save",
      supporting_fragment_ids: ["r1", "r2"],
    },
    {
      hook: "Coffee feels expensive. This costs less.",
      mechanism_claim: "Stable focus from morning chlorella",
      proof: "12-week study on energy",
      offer: "Free shipping",
      supporting_fragment_ids: ["ce1", "t1"],
    },
  ]);
  const { candidates } = await synthesizeAdAngles({
    fragments: FIXTURE_FRAGMENTS,
    patternMatrix: FIXTURE_MATRIX,
    k: 2,
    llm,
  });
  assert.equal(candidates.length, 2);
  for (const c of candidates) {
    assert.ok(typeof c.hook === "string" && c.hook.length > 0);
    assert.ok(typeof c.mechanism_claim === "string" && c.mechanism_claim.length > 0);
    assert.ok(typeof c.proof === "string" && c.proof.length > 0);
    assert.ok(typeof c.offer === "string" && c.offer.length > 0);
    assert.ok(Array.isArray(c.supporting_fragment_ids));
    assert.ok(c.supporting_fragment_ids.length > 0);
    assert.ok(c.score > 0, `expected non-zero score, got ${c.score}`);
  }
  // Higher matrix overlap should rank first.
  assert.ok(candidates[0].matrix_overlap >= candidates[1].matrix_overlap);
});

test("synthesizeAdAngles drops candidates that cite no real fragment ids", async () => {
  // Anchoring contract: if every supporting_fragment_id is hallucinated (not in
  // the input corpus), the candidate is dropped before scoring.
  const llm = stubLLM([
    {
      hook: "Real candidate.",
      mechanism_claim: "Clean energy no jitters",
      proof: "review",
      offer: "save",
      supporting_fragment_ids: ["r1"],
    },
    {
      hook: "Unanchored — cites nothing real.",
      mechanism_claim: "Made-up benefit",
      proof: "made-up study",
      offer: "made-up offer",
      supporting_fragment_ids: ["does-not-exist", "also-fake"],
    },
  ]);
  const { candidates } = await synthesizeAdAngles({
    fragments: FIXTURE_FRAGMENTS,
    patternMatrix: FIXTURE_MATRIX,
    llm,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].hook, "Real candidate.");
});

test("matrix-overlap signal rewards candidates that mirror the pattern matrix", async () => {
  // Two candidates citing the same single fragment — only the slot text
  // differs. The one matching the pattern matrix labels should score higher.
  const llm = stubLLM([
    {
      hook: "wake up tired today",
      mechanism_claim: "clean energy no jitters",
      proof: "3000 reviews",
      offer: "subscribe and save",
      supporting_fragment_ids: ["r1"],
    },
    {
      hook: "random unrelated opener",
      mechanism_claim: "unrelated mechanism claim text",
      proof: "unrelated proof line",
      offer: "unrelated offer line",
      supporting_fragment_ids: ["r1"],
    },
  ]);
  const { candidates } = await synthesizeAdAngles({
    fragments: FIXTURE_FRAGMENTS,
    patternMatrix: FIXTURE_MATRIX,
    llm,
  });
  assert.equal(candidates.length, 2);
  assert.ok(
    candidates[0].matrix_overlap > candidates[1].matrix_overlap,
    `expected matrix-aligned candidate to win: ${candidates[0].matrix_overlap} vs ${candidates[1].matrix_overlap}`,
  );
});

test("buildProposedAngleRows splits supporting fragment ids by source into mined_from", async () => {
  // The Phase-3 director sweep reads metadata.mined_from to know which DB rows
  // the angle was built on — verify each source's ids land in the right bucket
  // and that the row carries status='proposed' + generated_by='agent'.
  const rows = buildProposedAngleRows({
    workspaceId: "ws-1",
    productId: "p-coffee",
    leadBenefitAnchor: "Stable, all-day energy",
    fragments: FIXTURE_FRAGMENTS,
    candidates: [
      {
        hook: "Clean energy without jitters.",
        mechanism_claim: "Clean energy no jitters",
        proof: "3000 reviews",
        offer: "subscribe and save",
        supporting_fragment_ids: ["r1", "ce1", "t1"],
        matrix_overlap: 0.5,
        density: 0.3,
        score: 0.42,
      },
    ],
  });
  assert.equal(rows.length, 1);
  const r = rows[0] as Record<string, unknown>;
  assert.equal(r.workspace_id, "ws-1");
  assert.equal(r.product_id, "p-coffee");
  assert.equal(r.status, "proposed");
  assert.equal(r.generated_by, "agent");
  assert.equal(r.is_active, false);
  assert.equal(r.lead_benefit_anchor, "Stable, all-day energy");
  const meta = r.metadata as { mined_from: { review_ids: string[]; cancel_event_ids: string[]; ticket_ids: string[] }; score: number };
  assert.deepEqual(meta.mined_from.review_ids, ["r1"]);
  assert.deepEqual(meta.mined_from.cancel_event_ids, ["ce1"]);
  assert.deepEqual(meta.mined_from.ticket_ids, ["t1"]);
  assert.equal(meta.score, 0.42);
});
