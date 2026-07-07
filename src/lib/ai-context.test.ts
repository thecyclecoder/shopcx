/**
 * Unit tests for the ESTABLISHED PROBLEM prompt line composed by
 * establishedProblemPromptLine — the Phase-1 verification of
 * docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md pins
 * the exact string, so we pin it here too. Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/ai-context.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { establishedProblemPromptLine, renderDirectionSystemPrompt, type DirectionPlaybookSnapshot } from "./ai-context";
import type { TicketDirection } from "./ticket-directions";

test("T1 refund_request → the exact spec-verification string is emitted", () => {
  const line = establishedProblemPromptLine({ turn: 1, problem: "refund_request" });
  assert.equal(
    line,
    "ESTABLISHED PROBLEM (locked in at T1): refund_request. Any pivot MUST be justified explicitly in reasoning.",
  );
});

test("later-turn lock-in stamps its own turn index", () => {
  const line = establishedProblemPromptLine({ turn: 3, problem: "subscription_pause" });
  assert.match(line, /^ESTABLISHED PROBLEM \(locked in at T3\): subscription_pause\./);
});

// ─────────────────────────────────────────────────────────────────────────────
// Direction-scoped prompt renderer (M2 Phase 1)
// Covers Phase-1 verification bullets 1 + 2 + 3: the Direction-path suffix contains
// intent / context_summary / stringified guardrails and does NOT leak the customer
// name or order list assembleTicketContext would have injected; the playbook branch
// includes the current step context and the stateless branch does NOT.
// ─────────────────────────────────────────────────────────────────────────────

function makeDirection(overrides: Partial<TicketDirection> = {}): TicketDirection {
  return {
    id: "dir-1",
    workspace_id: "ws-1",
    ticket_id: "tkt-1",
    intent: "customer wants a refund on order #1234",
    context_summary: "VIP customer, 3rd order, damaged item confirmed via photo",
    chosen_path: "stateless",
    plan: { action: "issue_refund", amount_cents: 4999 },
    guardrails: { max_refund_cents: 5000, needs_photo: true, disallow_return_label: false },
    authored_by: "sol_box_session",
    authored_at: "2026-07-07T12:00:00Z",
    superseded_at: null,
    ...overrides,
  };
}

test("Direction path prompt contains intent, context_summary, and stringified guardrails", () => {
  const direction = makeDirection();
  const prompt = renderDirectionSystemPrompt(direction);
  assert.ok(prompt.includes(direction.intent), "prompt must include Direction.intent");
  assert.ok(prompt.includes(direction.context_summary), "prompt must include Direction.context_summary");
  assert.ok(prompt.includes(JSON.stringify(direction.guardrails)), "prompt must include stringified guardrails");
});

test("Direction path prompt does NOT leak assembleTicketContext's customer/orders section", () => {
  // Sol's context_summary should already carry any customer detail; the Direction-scoped
  // renderer must not re-inject the CUSTOMER CONTEXT / Recent Orders sections that
  // assembleTicketContext emits — that is the whole point of the cost inversion.
  const direction = makeDirection({
    context_summary: "customer summary lives here, no need for a name field",
  });
  const prompt = renderDirectionSystemPrompt(direction);
  assert.ok(!prompt.includes("CUSTOMER CONTEXT"), "must not include the CUSTOMER CONTEXT section header");
  assert.ok(!prompt.includes("Recent Orders"), "must not include the Recent Orders section header");
  assert.ok(!prompt.includes("Lifetime Value"), "must not include the LTV line");
  assert.ok(!prompt.includes("Retention Score"), "must not include the retention-score line");
});

test("Direction chosen_path='playbook' — playbook step context IS included", () => {
  const direction = makeDirection({ chosen_path: "playbook" });
  const playbook: DirectionPlaybookSnapshot = {
    playbook_id: "pb-1",
    playbook_name: "damaged_item_refund_v3",
    step_index: 2,
    step: { step_order: 2, kind: "confirm_refund", config: { min_photos: 1 } },
    playbook_context: { photo_urls: ["https://x/a.jpg"], offer_accepted: true },
  };
  const prompt = renderDirectionSystemPrompt(direction, playbook);
  assert.ok(prompt.includes("PLAYBOOK STEP"), "playbook branch must emit the PLAYBOOK STEP header");
  assert.ok(prompt.includes("damaged_item_refund_v3"), "playbook branch must include the playbook name");
  assert.ok(prompt.includes("confirm_refund"), "playbook branch must include the current step's kind");
  assert.ok(prompt.includes("offer_accepted"), "playbook branch must include playbook_context");
});

test("Direction chosen_path='stateless' — playbook step context is NOT included", () => {
  const direction = makeDirection({ chosen_path: "stateless" });
  const prompt = renderDirectionSystemPrompt(direction, null);
  assert.ok(!prompt.includes("PLAYBOOK STEP"), "stateless branch must NOT emit the PLAYBOOK STEP header");
});

test("stateless branch still omits playbook step even if a snapshot is accidentally passed in", () => {
  const direction = makeDirection({ chosen_path: "stateless" });
  const playbook: DirectionPlaybookSnapshot = {
    playbook_id: "pb-1",
    playbook_name: "leaked_playbook",
    step_index: 0,
    step: { kind: "should_not_appear" },
    playbook_context: {},
  };
  const prompt = renderDirectionSystemPrompt(direction, playbook);
  assert.ok(!prompt.includes("PLAYBOOK STEP"), "stateless renderer must not open the playbook section");
  assert.ok(!prompt.includes("should_not_appear"), "stateless renderer must not leak playbook step content");
});
