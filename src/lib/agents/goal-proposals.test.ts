/**
 * Unit tests for the PURE director-proposed-goal helpers (director-proposed-goals spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:goal-proposals
 *   (= tsx --test src/lib/agents/goal-proposals.test.ts)
 *
 * Covers the self-function scope rail, the slug guard, the rendered artifact (carries Status: proposed),
 * and the Status-line flip — plus deriveGoalStatus (brain-roadmap), the parse side of the new goal state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProposerOwnsFunction,
  isValidGoalSlug,
  buildProposedGoalMarkdown,
  setGoalStatusLine,
} from "./goal-proposals";
import { deriveGoalStatus, parseGoal } from "../brain-roadmap";

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
  });
  assert.match(md, /^# A proposed goal/m);
  assert.match(md, /\*\*Status:\*\* proposed/);
  assert.match(md, /\*\*Proposed-by:\*\* \[\[\.\.\/functions\/platform\]\]/);
  assert.match(md, /\*\*Owner:\*\* \[\[\.\.\/functions\/platform\]\]/);
  // The parser reads it back as a proposed, platform-owned, platform-proposed goal.
  const card = parseGoal("x", md, []);
  assert.equal(card.status, "proposed");
  assert.equal(card.owner, "platform");
  assert.equal(card.proposedBy, "platform");
  assert.equal(card.pct, 0);
});

test("setGoalStatusLine flips an existing Status line (proposed → greenlit)", () => {
  const md = "# T\n\n**Status:** proposed\n**Owner:** [[../functions/platform]]\n\nbody\n";
  const next = setGoalStatusLine(md, "greenlit");
  assert.match(next, /\*\*Status:\*\* greenlit/);
  assert.doesNotMatch(next, /\*\*Status:\*\* proposed/);
  assert.equal(parseGoal("t", next, []).status, "greenlit");
});

test("setGoalStatusLine inserts a Status line into a legacy goal that lacks one", () => {
  const legacy = "# Legacy goal\n\n**Outcome:** ship it\n\n## Decomposition\n- M0\n";
  const next = setGoalStatusLine(legacy, "greenlit");
  assert.match(next, /\*\*Status:\*\* greenlit/);
});

test("deriveGoalStatus: explicit marker wins; legacy infers greenlit/complete from pct", () => {
  assert.equal(deriveGoalStatus("proposed", 0), "proposed");
  assert.equal(deriveGoalStatus("greenlit", 0), "greenlit"); // greenlit 0% ≠ proposed 0%
  assert.equal(deriveGoalStatus("complete", 50), "complete");
  assert.equal(deriveGoalStatus("", 0), "greenlit"); // no marker → legacy active
  assert.equal(deriveGoalStatus("", 100), "complete"); // no marker, 100% → complete
});
