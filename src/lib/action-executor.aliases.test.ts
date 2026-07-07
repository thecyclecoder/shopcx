/**
 * Unit tests for the handler-alias resolver used by the action executor
 * (docs/brain/specs/orchestrator-handler-alias-catalog-for-no-handler-misses.md,
 * Phase 1). Tests the pure `pickAliasTarget` picker so the executor's
 * alias resolution can be verified without a DB.
 *
 * Run:
 *   npm run test:action-executor-aliases
 *   (= tsx --test src/lib/action-executor.aliases.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickAliasTarget, type AliasRow } from "./action-handler-aliases";

const WS = "00000000-0000-0000-0000-000000000001";
const OTHER_WS = "00000000-0000-0000-0000-000000000002";

test("global seed maps cancel_subscription → cancel", () => {
  const aliases: AliasRow[] = [
    { workspace_id: null, source_type: "cancel_subscription", target_type: "cancel", active: true },
  ];
  assert.equal(pickAliasTarget(aliases, WS, "cancel_subscription"), "cancel");
});

test("global seed maps refund_partial → partial_refund", () => {
  const aliases: AliasRow[] = [
    { workspace_id: null, source_type: "refund_partial", target_type: "partial_refund", active: true },
  ];
  assert.equal(pickAliasTarget(aliases, WS, "refund_partial"), "partial_refund");
});

test("source_type with no matching alias returns null (falls through to Unknown action type)", () => {
  const aliases: AliasRow[] = [
    { workspace_id: null, source_type: "cancel_subscription", target_type: "cancel", active: true },
  ];
  assert.equal(pickAliasTarget(aliases, WS, "foo_bar_baz"), null);
});

test("inactive global row is ignored (used to shadow-observe before flipping)", () => {
  const aliases: AliasRow[] = [
    { workspace_id: null, source_type: "cancel_subscription", target_type: "cancel", active: false },
  ];
  assert.equal(pickAliasTarget(aliases, WS, "cancel_subscription"), null);
});

test("workspace-scoped row wins over the global for the same source_type", () => {
  // Same source, different target — workspace overrides global.
  const aliases: AliasRow[] = [
    { workspace_id: null, source_type: "cancel_subscription", target_type: "cancel", active: true },
    { workspace_id: WS,   source_type: "cancel_subscription", target_type: "crisis_pause", active: true },
  ];
  assert.equal(pickAliasTarget(aliases, WS, "cancel_subscription"), "crisis_pause");
});

test("a workspace can disable a global by inserting an INACTIVE workspace-scoped row", () => {
  const aliases: AliasRow[] = [
    { workspace_id: null, source_type: "cancel_subscription", target_type: "cancel", active: true },
    { workspace_id: WS,   source_type: "cancel_subscription", target_type: "cancel", active: false },
  ];
  // Inactive scoped row is skipped, no active fallback → null.
  assert.equal(pickAliasTarget(aliases, WS, "cancel_subscription"), null);
});

test("a workspace-scoped row for OTHER_WS does not leak into WS's lookup", () => {
  const aliases: AliasRow[] = [
    { workspace_id: null,     source_type: "cancel_subscription", target_type: "cancel",       active: true },
    { workspace_id: OTHER_WS, source_type: "cancel_subscription", target_type: "crisis_pause", active: true },
  ];
  // WS sees only the global; OTHER_WS's override doesn't apply.
  assert.equal(pickAliasTarget(aliases, WS, "cancel_subscription"), "cancel");
  assert.equal(pickAliasTarget(aliases, OTHER_WS, "cancel_subscription"), "crisis_pause");
});

test("empty catalog resolves nothing (fresh install / RLS filtered everything)", () => {
  assert.equal(pickAliasTarget([], WS, "cancel_subscription"), null);
});

test("all four global seeds resolve to their canonical handler keys", () => {
  const seeds: AliasRow[] = [
    { workspace_id: null, source_type: "cancel_subscription", target_type: "cancel",         active: true },
    { workspace_id: null, source_type: "refund_partial",      target_type: "partial_refund", active: true },
    { workspace_id: null, source_type: "pause_subscription",  target_type: "pause",          active: true },
    { workspace_id: null, source_type: "resume_subscription", target_type: "resume",         active: true },
  ];
  assert.equal(pickAliasTarget(seeds, WS, "cancel_subscription"), "cancel");
  assert.equal(pickAliasTarget(seeds, WS, "refund_partial"),      "partial_refund");
  assert.equal(pickAliasTarget(seeds, WS, "pause_subscription"),  "pause");
  assert.equal(pickAliasTarget(seeds, WS, "resume_subscription"), "resume");
});
