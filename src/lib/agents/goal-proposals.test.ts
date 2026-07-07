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
  normalizePlannerBlockedBySlug,
  normalizePlannerBlockedByList,
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

// pia-decomposition-emits-plain-slug-blocked-by Phase 1 — the plain-slug write-path normalizer.
// The Pia decomposition write path (parsePlannerSpecs in scripts/builder-worker.ts) MUST emit blocked_by
// entries as bare member spec slugs — never namespaced `goalSlug:specSlug`, wikilinks, or path prefixes.
// The build-gating (areSpecsGoalMates + Kahn sort in src/lib/agent-jobs.ts) resolves each blocker string
// through the specs table by slug and does NOT split on `:` — a namespaced entry resolves to no spec, so
// the gate silently treats it as an external blocker and lets the dependent build out of order (the
// 2026-07-07 Sol-goal build shipped sol-cheap-execution-over-ticket-direction before its declared blocker
// sol-ticket-direction-artifact for exactly this reason). Normalize at the write path so the DB row's
// blocked_by is a list of plain slugs the gate can resolve.
test("normalizePlannerBlockedBySlug: strips a `goalSlug:specSlug` namespace prefix", () => {
  assert.equal(
    normalizePlannerBlockedBySlug("sol-agent-boot-goal:sol-ticket-direction-artifact"),
    "sol-ticket-direction-artifact",
  );
});

test("normalizePlannerBlockedBySlug: strips wikilink brackets + `../specs/` path prefix + `#anchor` suffix", () => {
  assert.equal(normalizePlannerBlockedBySlug("[[sol-ticket-direction-artifact]]"), "sol-ticket-direction-artifact");
  assert.equal(normalizePlannerBlockedBySlug("[[../specs/sol-ticket-direction-artifact]]"), "sol-ticket-direction-artifact");
  assert.equal(
    normalizePlannerBlockedBySlug("[[../specs/sol-ticket-direction-artifact#phase-2]]"),
    "sol-ticket-direction-artifact",
  );
});

test("normalizePlannerBlockedBySlug: passes a plain kebab slug through unchanged", () => {
  assert.equal(
    normalizePlannerBlockedBySlug("sol-ticket-direction-artifact"),
    "sol-ticket-direction-artifact",
  );
  assert.equal(normalizePlannerBlockedBySlug("m1-metric-groundwork"), "m1-metric-groundwork");
});

test("normalizePlannerBlockedBySlug: rejects empty / whitespace / junk that is not a resolvable slug", () => {
  assert.equal(normalizePlannerBlockedBySlug(""), null);
  assert.equal(normalizePlannerBlockedBySlug("   "), null);
  assert.equal(normalizePlannerBlockedBySlug("Not_A_Slug"), null);
  assert.equal(normalizePlannerBlockedBySlug("[[]]"), null);
});

test("normalizePlannerBlockedByList: filters non-strings, dedupes, drops the self-slug, keeps plain-slug order", () => {
  const out = normalizePlannerBlockedByList(
    [
      "sol-agent-boot-goal:sol-ticket-direction-artifact",
      "sol-cheap-execution-over-ticket-direction", // self — must be dropped
      "[[sol-ticket-direction-artifact]]", // duplicate after normalization — must be deduped
      "",
      null,
      42,
      "another-real-blocker",
    ] as unknown[],
    "sol-cheap-execution-over-ticket-direction",
  );
  assert.deepEqual(out, ["sol-ticket-direction-artifact", "another-real-blocker"]);
});

test("normalizePlannerBlockedByList: returns [] for a non-array input", () => {
  assert.deepEqual(normalizePlannerBlockedByList(undefined, "x"), []);
  assert.deepEqual(normalizePlannerBlockedByList(null, "x"), []);
  assert.deepEqual(normalizePlannerBlockedByList("not-an-array", "x"), []);
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
