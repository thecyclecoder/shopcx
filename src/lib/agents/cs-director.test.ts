/**
 * Unit tests for the CS Director (June) leash contract — Phase 3 of cs-director-leash-categories.
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:cs-director
 *   (= tsx --test src/lib/agents/cs-director.test.ts)
 *
 * Mirrors the growth-director.test.ts pattern for the pure-config leash surface: exercises the
 * `LEASH_CATEGORIES` union declared in `src/lib/agents/cs-director.ts` against its friendly copy in
 * `src/lib/agents/director-leash-guide.ts` and the `getLeashGuide('cs')` derivation. Guards two invariants
 * a follow-up edit could quietly break:
 *  - the three literal category strings stay stable (renaming one silently detaches the Guide tab from
 *    the applyBoxCsDirectorCall verdict paths the copy claims to describe);
 *  - every CS category has a real, hand-written CATEGORY_COPY entry — never the fallbackLine sentinel —
 *    so June never renders "add a friendly description in director-leash-guide.ts" to the founder.
 *
 * CS's runner (src/lib/cs-director.ts) exposes no `directorLeashCandidates`/`isAutoApprover` today, so
 * this test only covers the pure-config surface that IS declared. Behavior tests belong beside the
 * runner if/when those functions land.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LEASH_CATEGORIES, type LeashCategory } from "./cs-director";
import { CATEGORY_COPY, getLeashGuide } from "./director-leash-guide";

const EXPECTED: LeashCategory[] = [
  "approve_remedy_within_ceiling",
  "author_derived_from_ticket_spec",
  "amend_low_blast_sonnet_prompt",
];

test("LEASH_CATEGORIES declares exactly the three CS categories in the intended order", () => {
  assert.equal(LEASH_CATEGORIES.length, 3);
  assert.deepEqual(LEASH_CATEGORIES, EXPECTED);
});

test("every LEASH_CATEGORIES entry is one of the three known literals", () => {
  const allowed = new Set<string>(EXPECTED);
  for (const c of LEASH_CATEGORIES) {
    assert.ok(allowed.has(c), `unknown category surfaced: ${c}`);
  }
});

test("CATEGORY_COPY has a truthy entry with non-empty title + detail for every CS category", () => {
  for (const c of LEASH_CATEGORIES) {
    const line = CATEGORY_COPY[c];
    assert.ok(line, `CATEGORY_COPY is missing '${c}' — delete-one-entry guard triggered`);
    assert.equal(typeof line.title, "string");
    assert.equal(typeof line.detail, "string");
    assert.ok(line.title.trim().length > 0, `CATEGORY_COPY['${c}'].title is empty`);
    assert.ok(line.detail.trim().length > 0, `CATEGORY_COPY['${c}'].detail is empty`);
  }
});

test("getLeashGuide('cs') is defined with three autonomous lines matching CATEGORY_COPY", () => {
  const guide = getLeashGuide("cs");
  assert.equal(guide.defined, true);
  assert.equal(guide.autonomous.length, 3);
  for (let i = 0; i < LEASH_CATEGORIES.length; i++) {
    const category = LEASH_CATEGORIES[i];
    const line = guide.autonomous[i];
    assert.equal(line.title, CATEGORY_COPY[category].title);
    assert.equal(line.detail, CATEGORY_COPY[category].detail);
  }
});

test("getLeashGuide('cs').escalates includes the generic destructive / new-goal / unverifiable rails", () => {
  const { escalates } = getLeashGuide("cs");
  const titles = escalates.map((e) => e.title);
  assert.ok(titles.includes("Anything destructive or irreversible"));
  assert.ok(titles.includes("A brand-new feature or a new goal"));
  assert.ok(titles.includes("Any judgment call I can't fully verify"));
});
