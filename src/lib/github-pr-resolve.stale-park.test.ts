/**
 * `isStaleParkOnCleanPr` — which build-gate refusals a re-resolve may clear once the PR is clean.
 *
 * Ground truth 2026-10-13: #3193 / #2931 (pr-resolve parked on an advisory-supersede) and #3256 (build
 * parked on a reconcile-with-main conflict) were clean and tests-green but refused by the build gate for
 * 5–17 days, because nothing re-runs a parked job once its PR turns clean.
 *
 * Run: npx tsx --test src/lib/github-pr-resolve.stale-park.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStaleParkOnCleanPr } from "@/lib/github-pr-resolve";

const park = (ownerKind: string, ownerError: string) => ({ ok: false, status: "needs_attention", ownerKind, ownerError });

test("a pr-resolve advisory-supersede park is stale once clean (#3193, #2931)", () => {
  assert.equal(isStaleParkOnCleanPr(park("pr-resolve", "advisory-supersede: 2 exported symbol(s) also appear on main")), true);
});

test("a build parked on a reconcile-with-main conflict is stale once clean (#3256)", () => {
  assert.equal(isStaleParkOnCleanPr(park("build", "reconcile-with-main real conflict on 3 file(s) (rebase + merge)")), true);
});

test("a build that failed its own checks is never re-resolved", () => {
  assert.equal(isStaleParkOnCleanPr(park("build", "pre-commit self-verify unresolved after 2 repair passes")), false);
});

test("an authorization refusal is never re-resolved", () => {
  assert.equal(isStaleParkOnCleanPr(park("pr-resolve", "authorization: head repo is a fork")), false);
});

test("a passing gate or a non-parked status is not a park", () => {
  assert.equal(isStaleParkOnCleanPr({ ok: true, status: "completed", ownerKind: "build", ownerError: null }), false);
  assert.equal(isStaleParkOnCleanPr({ ok: false, status: "building", ownerKind: "build", ownerError: "conflict" }), false);
  assert.equal(isStaleParkOnCleanPr({ ok: false, status: "failed", ownerKind: "pr-resolve", ownerError: "x" }), false);
});
