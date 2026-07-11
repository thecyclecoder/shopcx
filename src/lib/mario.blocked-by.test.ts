/**
 * Unit tests for the fifth-source (missing-blocker) surface predicate — mario-blocked-by-repair
 * Phase 1. Pins the verification bullets:
 *
 *   1. a vale_pass=false spec whose body names prerequisite `foo` while `blocked_by` omits `foo`,
 *      all real phases having verification, aged past grace → SURFACED.
 *   2. a spec whose real phase is MISSING verification is NOT surfaced by the new source (no
 *      double-routing with the fourth source).
 *   3. a folded / deferred spec is DROPPED at the reader (the shared (b)/(c) filters cover the
 *      uncleared-blocker + wait-status-job cases against every source uniformly — those live in
 *      evaluateStalledSpecs' survivor loop, not the per-source reader).
 *
 * Pure predicate — no I/O, no DB. Run:
 *   npx tsx --test src/lib/mario.blocked-by.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractBlockedBySlugsFromBody, shouldSurfaceMissingBlocker } from "./mario";

const GRACE_MS = 60 * 60 * 1000;

const BODY_NAMES_FOO = [
  "# some-spec — an example",
  "",
  "**Owner:** [[../functions/platform]] · **Parent:** [[../functions/platform]] — some mandate.",
  "**Blocked-by:** [[foo]]",
  "",
  "## Phase 1 — do the thing",
  "…",
].join("\n");

const BODY_NAMES_FOO_AND_BAR = [
  "# some-spec — two prerequisites",
  "**Owner:** [[../functions/platform]]",
  "**Blocked-by:** [[foo]], [[bar]]",
].join("\n");

const BODY_NO_BLOCKED_BY_LINE = [
  "# some-spec — no prerequisites named",
  "**Owner:** [[../functions/platform]]",
  "",
  "## Phase 1 — do the thing",
].join("\n");

test("extractBlockedBySlugsFromBody: parses a single `[[foo]]` off the Blocked-by line", () => {
  assert.deepEqual(extractBlockedBySlugsFromBody(BODY_NAMES_FOO), ["foo"]);
});

test("extractBlockedBySlugsFromBody: parses multiple slugs off one Blocked-by line", () => {
  assert.deepEqual(extractBlockedBySlugsFromBody(BODY_NAMES_FOO_AND_BAR), ["foo", "bar"]);
});

test("extractBlockedBySlugsFromBody: strips the `../specs/` prefix and `.md` suffix", () => {
  const body = "**Blocked-by:** [[../specs/foo.md]]";
  assert.deepEqual(extractBlockedBySlugsFromBody(body), ["foo"]);
});

test("extractBlockedBySlugsFromBody: no Blocked-by line → empty array (not this class)", () => {
  assert.deepEqual(extractBlockedBySlugsFromBody(BODY_NO_BLOCKED_BY_LINE), []);
});

test(
  "Bullet 1 — vale_pass=false spec whose body names `foo`, blocked_by omits `foo`, all real phases have verification, aged past grace → SURFACED",
  () => {
    const surface = shouldSurfaceMissingBlocker({
      status: "in_review",
      ageMs: GRACE_MS + 1,
      graceMs: GRACE_MS,
      realPhases: [{ verification: "run the thing and grep the output" }],
      body: BODY_NAMES_FOO,
      blocked_by: [], // `foo` is named in the body but ABSENT from the row → missing-blocker class.
    });
    assert.equal(surface, true);
  },
);

test(
  "Bullet 2 — a missing-verification spec is NOT surfaced by the new source (no double-routing with the fourth source)",
  () => {
    const surface = shouldSurfaceMissingBlocker({
      status: "in_review",
      ageMs: GRACE_MS + 1,
      graceMs: GRACE_MS,
      // At least one real phase lacks verification → the FOURTH source (missing-verification)
      // owns this candidate, so the fifth source MUST return false.
      realPhases: [
        { verification: "the real check" },
        { verification: null },
      ],
      body: BODY_NAMES_FOO,
      blocked_by: [],
    });
    assert.equal(surface, false);
  },
);

test(
  "Bullet 3a — a folded spec is DROPPED at the reader (the shared (d) filter also catches it, but the reader short-circuits early)",
  () => {
    const surface = shouldSurfaceMissingBlocker({
      status: "folded",
      ageMs: GRACE_MS + 1,
      graceMs: GRACE_MS,
      realPhases: [{ verification: "the real check" }],
      body: BODY_NAMES_FOO,
      blocked_by: [],
    });
    assert.equal(surface, false);
  },
);

test("Bullet 3b — a deferred spec is DROPPED at the reader", () => {
  const surface = shouldSurfaceMissingBlocker({
    status: "deferred",
    ageMs: GRACE_MS + 1,
    graceMs: GRACE_MS,
    realPhases: [{ verification: "the real check" }],
    body: BODY_NAMES_FOO,
    blocked_by: [],
  });
  assert.equal(surface, false);
});

test("Within grace → NOT surfaced (Mario never races a human who is actively re-authoring)", () => {
  const surface = shouldSurfaceMissingBlocker({
    status: "in_review",
    ageMs: GRACE_MS - 1,
    graceMs: GRACE_MS,
    realPhases: [{ verification: "the real check" }],
    body: BODY_NAMES_FOO,
    blocked_by: [],
  });
  assert.equal(surface, false);
});

test("Every named prerequisite already in blocked_by → NOT surfaced (not the missing-blocker class)", () => {
  const surface = shouldSurfaceMissingBlocker({
    status: "in_review",
    ageMs: GRACE_MS + 1,
    graceMs: GRACE_MS,
    realPhases: [{ verification: "the real check" }],
    body: BODY_NAMES_FOO_AND_BAR,
    blocked_by: ["foo", "bar"],
  });
  assert.equal(surface, false);
});

test("Zero real phases (spec with only auto-generated fix phases) → NOT surfaced", () => {
  const surface = shouldSurfaceMissingBlocker({
    status: "in_review",
    ageMs: GRACE_MS + 1,
    graceMs: GRACE_MS,
    realPhases: [], // all phases were kind='fix' and got filtered out.
    body: BODY_NAMES_FOO,
    blocked_by: [],
  });
  assert.equal(surface, false);
});

test("No Blocked-by line in the body → NOT surfaced (Vale bounced for some OTHER reason, not this class)", () => {
  const surface = shouldSurfaceMissingBlocker({
    status: "in_review",
    ageMs: GRACE_MS + 1,
    graceMs: GRACE_MS,
    realPhases: [{ verification: "the real check" }],
    body: BODY_NO_BLOCKED_BY_LINE,
    blocked_by: [],
  });
  assert.equal(surface, false);
});

test("Body names two slugs, only one is missing → SURFACED (the missing entry is enough)", () => {
  const surface = shouldSurfaceMissingBlocker({
    status: "in_review",
    ageMs: GRACE_MS + 1,
    graceMs: GRACE_MS,
    realPhases: [{ verification: "the real check" }],
    body: BODY_NAMES_FOO_AND_BAR,
    blocked_by: ["foo"], // `bar` is named but absent → still missing-blocker.
  });
  assert.equal(surface, true);
});
