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
import { mineCustomerVoice } from "./customer-voice-mining";

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
