/**
 * Unit tests for the playbook-compiler seed-proposal payload builders
 * (spec: playbook-compiler-becomes-box-agent-mining-full-history Phase 2).
 *
 * Pins the invariants that the CI grep audit can't prove alone:
 *   (a) `buildProposedPlaybookRow` — every compiler-seeded playbook row
 *       lands with `is_active=false` + `proposed_by='playbook_compiler'` +
 *       trigger_intents derived from the tree's REAL intent_distribution
 *       (top-N by ticket_count), NEVER hand-guessed keywords.
 *   (b) `buildProposedPlaybookStepRows` — steps land as `type='custom'`
 *       (never a fine-grained flow-step type — the compiler doesn't
 *       fabricate those; the human approver refines), carry the
 *       orchestrator action_type verbatim in `config.action_type`, and
 *       preserve the resolution_sequence order.
 *   (c) `proposedPlaybookName` — deterministic name derived from the tree,
 *       so a re-run finds the existing row via the partial UNIQUE on
 *       `(workspace_id, source_tree_key)` instead of fanning duplicates.
 *
 * Run: `npx tsx --test src/lib/playbook-compiler-seed.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYBOOK_COMPILER_PROPOSED_BY,
  buildProposedPlaybookRow,
  buildProposedPlaybookStepRows,
  proposedPlaybookName,
  type CompiledTreeVerdict,
} from "./playbook-compiler";

const WS = "00000000-0000-0000-0000-000000000001";

function tree(overrides: Partial<CompiledTreeVerdict> = {}): CompiledTreeVerdict {
  return {
    tree_key: "melted_in_transit :: partial_refund+replacement",
    problem: "melted_in_transit",
    action_types: ["partial_refund", "replacement"],
    support: 42,
    sample_ticket_ids: ["t-1", "t-2"],
    intent_distribution: {
      product_damaged_in_transit: 30,
      melted_arrival: 12,
      shipping_delay_hot: 3,
    },
    resolution_sequence: [
      { action_type: "replacement", notes: "same variant, expedite" },
      { action_type: "partial_refund", notes: "10% subtotal" },
    ],
    evidence: { resolution_event_ids: ["r-1"], ticket_analyses_ids: ["a-1"] },
    reasoning: "42 tickets over the full history landed on this pattern.",
    ...overrides,
  };
}

test("buildProposedPlaybookRow: is_active=false + proposed_by='playbook_compiler'", () => {
  const row = buildProposedPlaybookRow(WS, tree());
  assert.equal(row.is_active, false, "compiler seed MUST land is_active=false");
  assert.equal(row.proposed_by, PLAYBOOK_COMPILER_PROPOSED_BY, "compiler seed MUST carry the provenance tag");
  assert.equal(row.workspace_id, WS);
  assert.equal(row.source_tree_key, "melted_in_transit :: partial_refund+replacement", "source_tree_key anchors idempotency");
});

test("buildProposedPlaybookRow: trigger_intents derived from real intent_distribution (top-N)", () => {
  const row = buildProposedPlaybookRow(WS, tree());
  // Top-3 by ticket_count, in descending order:
  assert.deepEqual(
    row.trigger_intents,
    ["product_damaged_in_transit", "melted_arrival", "shipping_delay_hot"],
    "trigger_intents come from the analyzer's real tag distribution, not hand-guessed keywords",
  );
});

test("buildProposedPlaybookRow: trigger_patterns fall back to the normalized problem", () => {
  const row = buildProposedPlaybookRow(WS, tree({ intent_distribution: {} }));
  assert.deepEqual(row.trigger_patterns, ["melted_in_transit"], "problem token is a data-grounded fallback trigger");
  assert.deepEqual(row.trigger_intents, [], "empty intent_distribution → empty trigger_intents (never hand-guessed)");
});

test("buildProposedPlaybookStepRows: type='custom' + config.action_type + order preserved", () => {
  const playbookId = "00000000-0000-0000-0000-000000000010";
  const rows = buildProposedPlaybookStepRows(WS, playbookId, tree());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, "custom", "compiler-seeded steps MUST land as type='custom' (never a fine-grained flow-step type)");
  assert.equal(rows[0].step_order, 0);
  assert.equal(rows[1].step_order, 1);
  assert.equal((rows[0].config as { action_type?: string }).action_type, "replacement");
  assert.equal((rows[1].config as { action_type?: string }).action_type, "partial_refund");
  assert.equal((rows[0].config as { source?: string }).source, PLAYBOOK_COMPILER_PROPOSED_BY);
  assert.equal((rows[0].config as { source_tree_key?: string }).source_tree_key, "melted_in_transit :: partial_refund+replacement");
});

test("buildProposedPlaybookStepRows: falls back to action_types tuple when resolution_sequence is empty", () => {
  const rows = buildProposedPlaybookStepRows(WS, "00000000-0000-0000-0000-000000000010", tree({ resolution_sequence: [] }));
  assert.equal(rows.length, 2);
  assert.equal((rows[0].config as { action_type?: string }).action_type, "partial_refund");
  assert.equal((rows[1].config as { action_type?: string }).action_type, "replacement");
  assert.equal(rows[0].type, "custom");
});

test("proposedPlaybookName: deterministic, human-readable, derived from the tree", () => {
  const name = proposedPlaybookName(tree());
  assert.equal(name, "Compiler seed — melted_in_transit → partial_refund + replacement");
  // Re-run over the same tree → same name → partial UNIQUE on (workspace_id, source_tree_key) hits the same row.
  assert.equal(proposedPlaybookName(tree()), name);
});
