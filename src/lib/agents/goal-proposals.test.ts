/**
 * Unit tests for the PURE director-proposed-goal helpers (director-proposed-goals spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:goal-proposals
 *   (= tsx --test src/lib/agents/goal-proposals.test.ts)
 *
 * Covers the self-function scope rail, the slug guard, the rendered artifact (carries Status: proposed),
 * and the Decomposition-block milestone extractor. (The goal STATE — proposed/greenlit/complete — is now
 * DB-driven: read from `public.goals` by the brain-roadmap goal readers; the markdown parse/flip helpers
 * it used to exercise are retired in goal-readers-from-db-retire-parsegoal.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProposerOwnsFunction,
  isValidGoalSlug,
  buildProposedGoalMarkdown,
  extractDecompositionMilestones,
} from "./goal-proposals";

test("a director may propose only for its OWN function", () => {
  assert.equal(assertProposerOwnsFunction("platform", "platform"), null);
  assert.match(assertProposerOwnsFunction("platform", "growth") ?? "", /only for its OWN function/);
  assert.match(assertProposerOwnsFunction("", "platform") ?? "", /required/);
});

test("goal slug guard accepts kebab, rejects junk", () => {
  assert.equal(isValidGoalSlug("deploy-health-rollback"), true);
  assert.equal(isValidGoalSlug("Deploy_Health"), false);
  assert.equal(isValidGoalSlug("-leading"), false);
  assert.equal(isValidGoalSlug("trailing-"), false);
});

test("rendered artifact carries Status: proposed + Proposed-by + Owner for the same function", () => {
  const md = buildProposedGoalMarkdown({
    proposerFunction: "platform",
    ownerFunction: "platform",
    slug: "x",
    title: "A proposed goal",
    outcome: "do the thing",
    successMetric: "metric up",
    target: "decompose via Pia",
    // pm-structured-intent-and-refs Phase 1 — required plain-language intent.
    why: "we're doing this so humans + agents share the goal's motivation",
  });
  assert.match(md, /^# A proposed goal/m);
  assert.match(md, /\*\*Status:\*\* proposed/);
  assert.match(md, /\*\*Proposed-by:\*\* \[\[\.\.\/functions\/platform\]\]/);
  assert.match(md, /\*\*Owner:\*\* \[\[\.\.\/functions\/platform\]\]/);
  assert.match(md, /\*\*Why:\*\* we're doing this so/);
});

test("extractDecompositionMilestones: default placeholder body → zero milestones (Pia decomposes)", () => {
  const md = buildProposedGoalMarkdown({
    proposerFunction: "platform",
    ownerFunction: "platform",
    slug: "x",
    title: "T",
    outcome: "do it",
    // pm-structured-intent-and-refs Phase 1 — required plain-language intent.
    why: "we need it",
  });
  assert.deepEqual(extractDecompositionMilestones(md), []);
});

test("extractDecompositionMilestones: parses Decomposition bullets into position/title/body", () => {
  const md = [
    "# T",
    "",
    "**Status:** proposed",
    "",
    "## Decomposition",
    "",
    "- **M1 — First milestone.** First-mile detail.",
    "  Extra wrap line for M1.",
    "- **M2 — Second milestone.**",
    "- Third item without bold M-id",
    "",
    "## Ownership & mirrors",
    "Owner: [[../functions/platform]].",
  ].join("\n");
  const out = extractDecompositionMilestones(md);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((m) => ({ position: m.position, title: m.title })),
    [
      { position: 1, title: "M1 — First milestone" },
      { position: 2, title: "M2 — Second milestone" },
      { position: 3, title: "Third item without bold M-id" },
    ],
  );
  // The body lines under M1 are captured; M2/M3 have no body.
  assert.match(out[0].body ?? "", /Extra wrap line for M1/);
  assert.equal(out[1].body, null);
  assert.equal(out[2].body, null);
});

test("extractDecompositionMilestones: ignores bullets outside the Decomposition section", () => {
  const md = [
    "# T",
    "",
    "## Ownership & mirrors",
    "- not a milestone",
    "",
    "## Decomposition",
    "- **M1 — Only this counts.**",
  ].join("\n");
  const out = extractDecompositionMilestones(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "M1 — Only this counts");
});
