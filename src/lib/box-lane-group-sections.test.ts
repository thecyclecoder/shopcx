/**
 * Unit tests for the build-box page's lane-group display derivation
 * (build-box-page-other-lanes-truthful-capacity-not-summed-caps Phase 1).
 * Pure helper — no DB, no React. Run:
 *   npm run test:box-lane-group-sections
 *   (= tsx --test src/lib/box-lane-group-sections.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveLaneGroupSections, LANE_GROUP_LABELS } from "./box-lane-group-sections";

// A representative heartbeat's lane_groups map — mirrors the shape LANE_GROUPS emits in
// scripts/builder-worker.ts. 'other' is 35 = SUM(all per-kind MAX_*), the phantom denominator this
// spec exists to remove.
const HEARTBEAT_LANE_GROUPS = {
  build_plan: { cap: 10, kinds: ["build", "plan"] },
  customer_service: { cap: 5, kinds: ["ticket-handle", "ticket-analyze", "cs-director-call"] },
  director: { cap: 2, kinds: ["platform-director", "director-bounce-back", "growth-director", "director-coach"] },
  fold: { cap: 1, kinds: ["fold", "goal-fold"] },
  other: {
    cap: 35,
    kinds: [
      "product-seed", "spec-chat", "ticket-improve", "triage-escalations", "spec-test", "spec-review",
      "migration-fix", "deploy-review", "playbook-compile", "prompt-review", "dev-ask", "god-mode",
      "pr-resolve", "repair", "regression", "security-review", "agent-grade", "agent-coach",
      "director-grade", "campaign-grade", "gap-grade", "research", "dr-content", "media-buyer",
      "media-buyer-grade", "storefront-optimizer", "db_health", "coverage-register", "proposed-goal",
      "proposed-model-tier",
    ],
  },
};

test("'other' group's derived cap is NOT the arithmetic sum of the per-kind caps", () => {
  const lanes = [
    { kind: "spec-test" },
    { kind: "agent-grade" },
    { kind: "agent-coach" },
    { kind: "research" },
  ];
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, lanes);
  assert.ok(sections, "derivation returned a section list");
  const other = sections!.find((s) => s.key === "other");
  assert.ok(other, "'other' section is present");
  // The core assertion this spec exists to encode: no more phantom "4/35 in use" —
  // the summed sum-of-caps must not surface as the section's rendered ceiling.
  assert.notEqual(other!.cap, 35, "'other' must not surface the summed sum-of-caps as a real ceiling");
  assert.notEqual(other!.cap, HEARTBEAT_LANE_GROUPS.other.cap, "'other' must not echo the heartbeat's summed cap");
  assert.equal(other!.cap, null, "'other' section uses truthful active-count display (cap=null → no denominator)");
  assert.equal(other!.lanes.length, 4, "all four supervisory kinds are filtered into the 'other' bucket");
});

test("real concurrent pools keep their cap exactly as-is (build/plan 10, CS 5, director 2, fold 1)", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, []);
  assert.ok(sections);
  assert.equal(sections!.find((s) => s.key === "build_plan")!.cap, 10);
  assert.equal(sections!.find((s) => s.key === "customer_service")!.cap, 5);
  assert.equal(sections!.find((s) => s.key === "director")!.cap, 2);
  assert.equal(sections!.find((s) => s.key === "fold")!.cap, 1);
});

test("'other' section reads as autonomous supervisory agents, not a summed lane pool", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, []);
  const other = sections!.find((s) => s.key === "other")!;
  assert.equal(other.label, "Supervisory agents", "label must not carry the misleading 'lanes' wording");
  assert.equal(LANE_GROUP_LABELS.other, "Supervisory agents");
  assert.notEqual(other.label.toLowerCase(), "other lanes", "'Other lanes' was the misleading pre-fix label");
});

test("legacy heartbeat with null lane_groups returns null (page falls back to old single-pool render)", () => {
  assert.equal(deriveLaneGroupSections(null, []), null);
  assert.equal(deriveLaneGroupSections(undefined, [{ kind: "build" }]), null);
});

test("filters lanes into each section by the group's kind-set", () => {
  const lanes = [
    { kind: "build" }, // build_plan
    { kind: "plan" }, // build_plan
    { kind: "ticket-handle" }, // customer_service
    { kind: "fold" }, // fold
    { kind: "spec-test" }, // other
    { kind: "agent-grade" }, // other
  ];
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, lanes);
  assert.equal(sections!.find((s) => s.key === "build_plan")!.lanes.length, 2);
  assert.equal(sections!.find((s) => s.key === "customer_service")!.lanes.length, 1);
  assert.equal(sections!.find((s) => s.key === "director")!.lanes.length, 0);
  assert.equal(sections!.find((s) => s.key === "fold")!.lanes.length, 1);
  assert.equal(sections!.find((s) => s.key === "other")!.lanes.length, 2);
});

test("sections are emitted in the fixed display order (build/plan → CS → director → fold → supervisory)", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, []);
  assert.deepEqual(
    sections!.map((s) => s.key),
    ["build_plan", "customer_service", "director", "fold", "other"],
  );
});
