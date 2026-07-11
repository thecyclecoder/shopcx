/**
 * Unit tests for the DETERMINISTIC spec-review gate
 * ([[../../docs/brain/libraries/spec-review-gate]] · Phase 1 of
 * [[../../docs/brain/specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]]).
 *
 * The pure predicate `computeSpecReviewProblems` MUST reject each defect class the Vale LLM checklist
 * covered (contiguous phase sequence, Owner resolves, Parent resolves via DB, Blocked-by resolves +
 * acyclic, customer_id table with a companion data-tool plan, every phase carries Verification) with
 * the exact human-readable failure Vale would have named — and pass a well-formed spec instantly.
 *
 * Run:
 *   npm run test:spec-review-gate
 *   (= tsx --test src/lib/spec-review-gate.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSpecReviewProblems,
  type SpecReviewGateContext,
  type SpecReviewGateInput,
} from "./spec-review-gate";

/** A neutral context: platform + growth are real functions, no other specs exist yet, no goals. Each
 *  test overrides the pieces it pins. */
function ctx(overrides: Partial<SpecReviewGateContext> = {}): SpecReviewGateContext {
  return {
    knownFunctionSlugs: new Set(["platform", "growth", "cs"]),
    knownSpecSlugs: new Set(["existing-a", "existing-b"]),
    blockedByGraph: new Map<string, string[]>([
      ["existing-a", []],
      ["existing-b", []],
    ]),
    knownMandateRefs: new Set(["platform#build", "platform#reliability"]),
    knownMilestoneIds: new Set(["11111111-1111-1111-1111-111111111111"]),
    knownGoalMilestones: new Map([["some-goal", new Set(["m1", "cool-milestone"])]]),
    ...overrides,
  };
}

/** A well-formed spec baseline — every test starts here and mutates one field to induce a defect. */
function wellFormed(): SpecReviewGateInput {
  return {
    slug: "my-spec",
    owner: "platform",
    parent: "[[../functions/platform]] — \"Build\" mandate: because.",
    parent_kind: "mandate",
    parent_ref: "platform#build",
    blocked_by: [],
    milestone_id: null,
    phases: [
      { position: 1, title: "Do the thing", body: "Body text.", verification: "- Check X." },
      { position: 2, title: "Do more", body: "Body two.", verification: "- Check Y." },
    ],
  };
}

test("well-formed spec produces zero problems", () => {
  const problems = computeSpecReviewProblems(wellFormed(), ctx());
  assert.deepEqual(problems, []);
});

test("missing Owner is flagged as `no **Owner:** line`", () => {
  const input = { ...wellFormed(), owner: "" };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(problems.some((p) => p === "no **Owner:** line"), `got: ${problems.join(" | ")}`);
});

test("unresolved Owner slug is flagged with the missing function slug", () => {
  const input = { ...wellFormed(), owner: "nonesuch" };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p.includes("nonesuch") && p.includes("does not resolve")),
    `got: ${problems.join(" | ")}`,
  );
});

test("duplicate phase position is flagged as `Phase N appears twice`", () => {
  const input = {
    ...wellFormed(),
    phases: [
      { position: 1, title: "A", body: "b", verification: "- x" },
      { position: 1, title: "B", body: "b", verification: "- x" },
    ],
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p === "Phase 1 appears twice"),
    `got: ${problems.join(" | ")}`,
  );
});

test("out-of-order / gap in phase positions is flagged", () => {
  const input = {
    ...wellFormed(),
    phases: [
      { position: 1, title: "A", body: "b", verification: "- x" },
      { position: 3, title: "C", body: "b", verification: "- x" },
    ],
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p.startsWith("Phase 2 is missing")),
    `got: ${problems.join(" | ")}`,
  );
  assert.ok(
    problems.some((p) => p.startsWith("Phase 3 is out-of-order")),
    `got: ${problems.join(" | ")}`,
  );
});

test("empty verification on a phase is flagged as `Phase N has no ### Verification block`", () => {
  const input = {
    ...wellFormed(),
    phases: [
      { position: 1, title: "A", body: "b", verification: "- x" },
      { position: 2, title: "B", body: "b", verification: "" },
    ],
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p === "Phase 2 has no `### Verification` block"),
    `got: ${problems.join(" | ")}`,
  );
});

test("typed parent_ref that does not resolve is flagged", () => {
  const input = { ...wellFormed(), parent_kind: "mandate" as const, parent_ref: "platform#missing" };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p.includes("platform#missing") && p.includes("does not resolve")),
    `got: ${problems.join(" | ")}`,
  );
});

test("bound milestone_id that does not resolve is flagged", () => {
  const input = {
    ...wellFormed(),
    parent_kind: null,
    parent_ref: null,
    milestone_id: "22222222-2222-2222-2222-222222222222",
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p.includes("22222222") && p.includes("does not resolve")),
    `got: ${problems.join(" | ")}`,
  );
});

test("untyped goal parent with unknown goal is flagged", () => {
  const input = {
    ...wellFormed(),
    parent: "[[../goals/no-such-goal#m1]] — M1 milestone.",
    parent_kind: null,
    parent_ref: null,
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p.includes("no-such-goal") && p.includes("does not resolve")),
    `got: ${problems.join(" | ")}`,
  );
});

test("untyped goal parent with unknown milestone anchor is flagged", () => {
  const input = {
    ...wellFormed(),
    parent: "[[../goals/some-goal#never-existed]] — bogus milestone.",
    parent_kind: null,
    parent_ref: null,
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p.includes("never-existed") && p.includes("does not resolve")),
    `got: ${problems.join(" | ")}`,
  );
});

test("Blocked-by slug that does not resolve is flagged as `Blocked-by [[x]] does not resolve`", () => {
  const input = { ...wellFormed(), blocked_by: ["existing-a", "phantom-spec"] };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some((p) => p === "Blocked-by `[[phantom-spec]]` does not resolve to a spec"),
    `got: ${problems.join(" | ")}`,
  );
  // The resolvable one produces no problem.
  assert.ok(
    !problems.some((p) => p.includes("existing-a")),
    `existing-a should resolve; got: ${problems.join(" | ")}`,
  );
});

test("Blocked-by list forming a cycle including this spec is flagged", () => {
  // existing-a → my-spec (existing edge)
  //     my-spec → existing-a (proposed edge)
  // ⇒ cycle: my-spec → existing-a → my-spec.
  const c = ctx({
    blockedByGraph: new Map<string, string[]>([
      ["existing-a", ["my-spec"]],
      ["existing-b", []],
    ]),
    knownSpecSlugs: new Set(["existing-a", "existing-b", "my-spec"]),
  });
  const input = { ...wellFormed(), blocked_by: ["existing-a"] };
  const problems = computeSpecReviewProblems(input, c);
  assert.ok(
    problems.some((p) => p.includes("forms a cycle") && p.includes("my-spec")),
    `got: ${problems.join(" | ")}`,
  );
});

test("customer_id table with no data-tool plan is flagged", () => {
  const input = {
    ...wellFormed(),
    phases: [
      {
        position: 1,
        title: "Add table",
        body:
          "```sql\nCREATE TABLE public.foo (\n  customer_id uuid NOT NULL,\n  data jsonb\n);\n```",
        verification: "- Check X.",
      },
    ],
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    problems.some(
      (p) => p.includes("customer_id") && p.includes("no data-tool plan") && p.includes("sonnet-orchestrator-v2"),
    ),
    `got: ${problems.join(" | ")}`,
  );
});

test("customer_id table WITH a sonnet-orchestrator-v2 companion mention passes", () => {
  const input = {
    ...wellFormed(),
    phases: [
      {
        position: 1,
        title: "Add table",
        body:
          "```sql\nCREATE TABLE public.foo (\n  customer_id uuid NOT NULL,\n  data jsonb\n);\n```\n\n" +
          "Also wire a new data tool in `src/lib/sonnet-orchestrator-v2.ts` so the tool is discoverable.",
        verification: "- Check X.",
      },
    ],
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    !problems.some((p) => p.includes("customer_id")),
    `should NOT flag customer_id when sonnet-orchestrator-v2 companion is mentioned; got: ${problems.join(" | ")}`,
  );
});

test("incidental customer_id mention (no DDL) does not false-positive", () => {
  const input = {
    ...wellFormed(),
    phases: [
      {
        position: 1,
        title: "Read customer",
        body: "We look up the customer_id from the session and read the row.",
        verification: "- Check X.",
      },
    ],
  };
  const problems = computeSpecReviewProblems(input, ctx());
  assert.ok(
    !problems.some((p) => p.includes("customer_id")),
    `should NOT flag an incidental customer_id lookup; got: ${problems.join(" | ")}`,
  );
});

test("multiple defects surface together (Vale-style batch)", () => {
  const input: SpecReviewGateInput = {
    slug: "malformed",
    owner: "",
    parent: "[[../goals/no-such-goal]] — nope.",
    parent_kind: null,
    parent_ref: null,
    blocked_by: ["phantom"],
    phases: [
      { position: 1, title: "A", body: "b", verification: "- x" },
      { position: 1, title: "A-dup", body: "b", verification: "" },
    ],
  };
  const problems = computeSpecReviewProblems(input, ctx());
  // Owner, dup phase, missing verification on phase 1 (dup), goal does not resolve, blocked-by does not resolve.
  assert.ok(problems.length >= 4, `expected >= 4 problems, got: ${problems.length} — ${problems.join(" | ")}`);
});
