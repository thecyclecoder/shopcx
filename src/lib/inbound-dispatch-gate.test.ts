/**
 * Unit tests for the Phase-1 inbound-dispatch-gate predicate.
 *
 * These pin the exact behavior the spec's verification bullets require:
 *
 *   npx tsx --test src/lib/inbound-dispatch-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldDispatchInboundMessage, type InboundDispatchState } from "./inbound-dispatch-gate";

const base: InboundDispatchState = {
  ai_handled_at: null,
  assigned_to: null,
  ai_disabled: false,
  do_not_reply: false,
};

test("divergence case — ai_handled_at set, no assigned_to → DISPATCHES (spec bullet 1)", () => {
  // The `c4889020` failure mode. The universal handling anchor is set (AI has been answering),
  // but the legacy `ai_handled` boolean the old gate read was still stale/false. The new gate
  // decides off `ai_handled_at` and must dispatch this ticket's fresh customer reply.
  assert.equal(
    shouldDispatchInboundMessage({ ...base, ai_handled_at: "2026-07-01T00:00:00Z" }),
    true,
  );
});

test("divergence case — ai_handled_at set + assigned_to set → still DISPATCHES", () => {
  // The AI has been handling the conversation; a soft/pooled human assignment does not stop the
  // next turn. This is the same class of divergence as bullet 1 with an additional stored owner.
  assert.equal(
    shouldDispatchInboundMessage({
      ...base,
      ai_handled_at: "2026-07-01T00:00:00Z",
      assigned_to: "11111111-1111-1111-1111-111111111111",
    }),
    true,
  );
});

test("human owns ticket, no AI handling stamp → does NOT dispatch (spec bullet 2)", () => {
  assert.equal(
    shouldDispatchInboundMessage({
      ...base,
      ai_handled_at: null,
      assigned_to: "11111111-1111-1111-1111-111111111111",
    }),
    false,
  );
});

test("no owner + no handling stamp → dispatches (fresh unowned ticket)", () => {
  assert.equal(shouldDispatchInboundMessage(base), true);
});

test("ai_disabled hard-stops even when ai_handled_at set", () => {
  assert.equal(
    shouldDispatchInboundMessage({
      ...base,
      ai_handled_at: "2026-07-01T00:00:00Z",
      ai_disabled: true,
    }),
    false,
  );
});

test("do_not_reply hard-stops even when ai_handled_at set", () => {
  assert.equal(
    shouldDispatchInboundMessage({
      ...base,
      ai_handled_at: "2026-07-01T00:00:00Z",
      do_not_reply: true,
    }),
    false,
  );
});

test("predicate NEVER reads a legacy ai_handled boolean — the state shape has none", () => {
  // Compile-time proof: `InboundDispatchState` doesn't declare `ai_handled`. A future refactor
  // that tries to feed the stale boolean back in has to change this test, which forces the reader
  // back to the spec.
  const t: InboundDispatchState = base;
  assert.equal("ai_handled" in t, false);
});
