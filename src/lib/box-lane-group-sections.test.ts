/**
 * Unit tests for the build-box page's lane-group display derivation.
 *
 * Two specs live here:
 *   - build-box-page-other-lanes-truthful-capacity-not-summed-caps — the `other` bucket carries no
 *     phantom denominator (cap:null, active-count-only) — kept as regressions on both derived
 *     sections.
 *   - box-page-split-producer-vs-supervisory-lane-groups Phase 1 — the single `other` heartbeat
 *     group is fanned into TWO display sections (producer + supervisory) so a domain producer like
 *     ad-creative-copy-author does not read as a supervisor.
 *
 * Pure helper — no DB, no React. Run:
 *   npm run test:box-lane-group-sections
 *   (= tsx --test src/lib/box-lane-group-sections.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveLaneGroupSections, LANE_GROUP_LABELS, PRODUCER_KINDS } from "./box-lane-group-sections";

// A representative heartbeat's lane_groups map — mirrors the shape LANE_GROUPS emits in
// scripts/builder-worker.ts. `other` mixes producer kinds (ad-creative*, dr-content, media-buyer,
// product-seed, storefront-optimizer) with supervisory kinds (spec-test, agent-grade, ...).
const HEARTBEAT_LANE_GROUPS = {
  build_plan: { cap: 10, kinds: ["build", "plan"] },
  customer_service: { cap: 5, kinds: ["ticket-handle", "ticket-analyze", "cs-director-call"] },
  director: { cap: 2, kinds: ["platform-director", "director-bounce-back", "growth-director", "director-coach"] },
  fold: { cap: 1, kinds: ["fold", "goal-fold"] },
  other: {
    cap: 35,
    kinds: [
      "product-seed", "spec-chat", "ticket-improve", "triage-escalations", "spec-test",
      "migration-fix", "deploy-review", "mario", "playbook-compile", "prompt-review", "dev-ask", "god-mode",
      "pr-resolve", "repair", "regression", "security-review", "agent-grade", "agent-coach",
      "director-grade", "campaign-grade", "gap-grade", "research", "dr-content", "media-buyer",
      "media-buyer-grade", "ad-creative", "ad-creative-copy-author", "ad-creative-copy-qc",
      "storefront-optimizer", "db_health", "coverage-register", "proposed-goal", "proposed-model-tier",
    ],
  },
};

test("supervisory section's derived cap is NOT the arithmetic sum of the per-kind caps", () => {
  const lanes = [
    { kind: "spec-test" },
    { kind: "agent-grade" },
    { kind: "agent-coach" },
    { kind: "research" },
  ];
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, lanes);
  assert.ok(sections, "derivation returned a section list");
  const supervisory = sections!.find((s) => s.key === "supervisory");
  assert.ok(supervisory, "'supervisory' section is present");
  // No more phantom "4/35 in use" — the summed sum-of-caps must not surface as the section ceiling.
  assert.notEqual(supervisory!.cap, 35, "supervisory must not surface the summed sum-of-caps as a real ceiling");
  assert.equal(supervisory!.cap, null, "supervisory section uses truthful active-count display (cap=null → no denominator)");
  assert.equal(supervisory!.lanes.length, 4, "all four supervisory kinds are filtered into the supervisory bucket");
});

test("producer section carries cap:null and no phantom summed cap either", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, [
    { kind: "ad-creative" },
    { kind: "dr-content" },
  ]);
  const producer = sections!.find((s) => s.key === "producer")!;
  assert.equal(producer.cap, null, "producer section uses truthful active-count display (cap=null → no denominator)");
  assert.notEqual(producer.cap, 35, "producer must not carry the heartbeat's summed cap either");
  assert.equal(producer.lanes.length, 2);
});

test("real concurrent pools keep their cap exactly as-is (build/plan 10, CS 5, director 2, fold 1)", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, []);
  assert.ok(sections);
  assert.equal(sections!.find((s) => s.key === "build_plan")!.cap, 10);
  assert.equal(sections!.find((s) => s.key === "customer_service")!.cap, 5);
  assert.equal(sections!.find((s) => s.key === "director")!.cap, 2);
  assert.equal(sections!.find((s) => s.key === "fold")!.cap, 1);
});

test("supervisory section is labeled 'Supervisory agents' (LANE_GROUP_LABELS + section label)", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, []);
  const supervisory = sections!.find((s) => s.key === "supervisory")!;
  assert.equal(supervisory.label, "Supervisory agents");
  assert.equal(LANE_GROUP_LABELS.supervisory, "Supervisory agents");
});

test("producer section is labeled 'Producer agents' (LANE_GROUP_LABELS + section label)", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, []);
  const producer = sections!.find((s) => s.key === "producer")!;
  assert.equal(producer.label, "Producer agents");
  assert.equal(LANE_GROUP_LABELS.producer, "Producer agents");
});

test("legacy heartbeat with null lane_groups returns null (page falls back to old single-pool render)", () => {
  assert.equal(deriveLaneGroupSections(null, []), null);
  assert.equal(deriveLaneGroupSections(undefined, [{ kind: "build" }]), null);
});

test("filters lanes into each section by the group's kind-set — supervisory catches spec-test/agent-grade", () => {
  const lanes = [
    { kind: "build" }, // build_plan
    { kind: "plan" }, // build_plan
    { kind: "ticket-handle" }, // customer_service
    { kind: "fold" }, // fold
    { kind: "spec-test" }, // supervisory
    { kind: "agent-grade" }, // supervisory
  ];
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, lanes);
  assert.equal(sections!.find((s) => s.key === "build_plan")!.lanes.length, 2);
  assert.equal(sections!.find((s) => s.key === "customer_service")!.lanes.length, 1);
  assert.equal(sections!.find((s) => s.key === "director")!.lanes.length, 0);
  assert.equal(sections!.find((s) => s.key === "fold")!.lanes.length, 1);
  assert.equal(sections!.find((s) => s.key === "supervisory")!.lanes.length, 2);
  assert.equal(sections!.find((s) => s.key === "producer")!.lanes.length, 0);
});

test("sections are emitted in the fixed display order (build/plan → CS → director → fold → producer → supervisory)", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, []);
  assert.deepEqual(
    sections!.map((s) => s.key),
    ["build_plan", "customer_service", "director", "fold", "producer", "supervisory"],
  );
});

// box-page-split-producer-vs-supervisory-lane-groups Phase 1 — the core acceptance tests.

test("PRODUCER_KINDS is exported and holds the seven artifact-creator kinds", () => {
  const expected = [
    "product-seed",
    "dr-content",
    "media-buyer",
    "ad-creative",
    "ad-creative-copy-author",
    "ad-creative-copy-qc",
    "storefront-optimizer",
  ];
  for (const k of expected) {
    assert.equal(PRODUCER_KINDS.has(k), true, `PRODUCER_KINDS must include ${k}`);
  }
  assert.equal(PRODUCER_KINDS.size, expected.length, "no extra producer kinds — the set is exactly these seven");
});

test("a lane set spanning both buckets yields two sections with the right membership", () => {
  const lanes = [
    { kind: "ad-creative-copy-author" }, // producer (Dahlia — the CEO-flagged case)
    { kind: "ad-creative" }, // producer
    { kind: "dr-content" }, // producer
    { kind: "spec-test" }, // supervisory
    { kind: "agent-grade" }, // supervisory
    { kind: "agent-coach" }, // supervisory
  ];
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, lanes);
  assert.ok(sections);
  const producer = sections!.find((s) => s.key === "producer");
  const supervisory = sections!.find((s) => s.key === "supervisory");
  assert.ok(producer, "producer section is emitted");
  assert.ok(supervisory, "supervisory section is emitted");
  assert.deepEqual(
    producer!.lanes.map((l) => l.kind).sort(),
    ["ad-creative", "ad-creative-copy-author", "dr-content"],
    "ad-creative-copy-author (Dahlia) and the other artifact-creators land in producer",
  );
  assert.deepEqual(
    supervisory!.lanes.map((l) => l.kind).sort(),
    ["agent-coach", "agent-grade", "spec-test"],
    "spec-test / agent-grade / agent-coach land in supervisory",
  );
});

test("an all-supervisory lane set yields an empty producer section and a populated supervisory section", () => {
  const lanes = [
    { kind: "spec-test" },
    { kind: "agent-grade" },
    { kind: "agent-coach" },
    { kind: "deploy-review" },
    { kind: "security-review" },
    { kind: "migration-fix" },
    { kind: "director-grade" },
    { kind: "repair" },
    { kind: "regression" },
  ];
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, lanes);
  const producer = sections!.find((s) => s.key === "producer")!;
  const supervisory = sections!.find((s) => s.key === "supervisory")!;
  assert.equal(producer.lanes.length, 0, "producer section is empty when only supervisors are running");
  assert.equal(supervisory.lanes.length, lanes.length, "every supervisory lane lands in supervisory");
});

test("a NEW unknown `other` kind defaults to supervisory (never dropped from the display)", () => {
  // The heartbeat's kind-set grew to include a new supervisory-like kind before the derivation
  // knew about it. It must default to supervisory rather than silently vanish.
  const heartbeat = {
    ...HEARTBEAT_LANE_GROUPS,
    other: {
      ...HEARTBEAT_LANE_GROUPS.other,
      kinds: [...HEARTBEAT_LANE_GROUPS.other.kinds, "brand-new-oversight-kind"],
    },
  };
  const lanes = [{ kind: "brand-new-oversight-kind" }];
  const sections = deriveLaneGroupSections(heartbeat, lanes);
  const producer = sections!.find((s) => s.key === "producer")!;
  const supervisory = sections!.find((s) => s.key === "supervisory")!;
  assert.equal(producer.lanes.length, 0, "unknown kind must NOT land in producer");
  assert.equal(supervisory.lanes.length, 1, "unknown kind defaults to supervisory");
  assert.equal(supervisory.lanes[0].kind, "brand-new-oversight-kind");
});

test("Dahlia (ad-creative-copy-author) — the CEO-flagged case — lands in producer, not supervisory", () => {
  const sections = deriveLaneGroupSections(HEARTBEAT_LANE_GROUPS, [{ kind: "ad-creative-copy-author" }]);
  const producer = sections!.find((s) => s.key === "producer")!;
  const supervisory = sections!.find((s) => s.key === "supervisory")!;
  assert.equal(producer.lanes.length, 1);
  assert.equal(producer.lanes[0].kind, "ad-creative-copy-author");
  assert.equal(supervisory.lanes.length, 0, "ad-creative-copy-author must not read as a supervisor");
});
