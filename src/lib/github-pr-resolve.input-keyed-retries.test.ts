/**
 * Unit tests for the pr-resolve input fingerprint — pr-resolve-retries-key-on-the-INPUT-not-a-
 * lifetime-budget (2026-08-11).
 *
 * A pr-resolve verdict is a pure function of (PR head commit, main commit it merges into). Same pair ⇒
 * byte-identical verdict. Two live failures came from not keying on that:
 *
 *   WASTE — PR #2450 got THREE resolver box sessions inside two minutes (16:28:22 / 16:29:19 /
 *   16:30:06), each recomputing the identical "advisory-supersede: 39 exported symbol(s) also appear on
 *   main". Each finished in ~50s so the active-job dedup never overlapped them.
 *
 *   FORECLOSURE — PR #2416 burned its 3 lifetime attempts the same way, was marked exhausted, then sat
 *   CONFLICTING for three days while `main` advanced ~29 commits underneath it. Every one of those
 *   changed the merge result; not one could be attempted. It was resolved by hand.
 *
 * Run:  npx tsx --test src/lib/github-pr-resolve.input-keyed-retries.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  prResolveFingerprint,
  fingerprintOfPrResolveRow,
  countGenuinePrResolveAttempts,
  PR_RESOLVE_MAX_ATTEMPTS_FOR_TESTS,
} from "./github-pr-resolve";

test("the fingerprint is the (head, base) pair — both are load-bearing", () => {
  const fp = prResolveFingerprint("aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb");
  assert.equal(fp, "aaaaaaaaaaaa:bbbbbbbbbbbb");
  // A new push changes it.
  assert.notEqual(fp, prResolveFingerprint("cccccccccccccccc", "bbbbbbbbbbbbbbbb"));
  // `main` advancing changes it too — that is the case #2416 needed and could not get.
  assert.notEqual(fp, prResolveFingerprint("aaaaaaaaaaaaaaaa", "dddddddddddddddd"));
});

test("an unknown SHA yields NO fingerprint — degrades to the old lifetime cap, never a false match", () => {
  assert.equal(prResolveFingerprint(null, "bbbbbbbbbbbb"), null);
  assert.equal(prResolveFingerprint("aaaaaaaaaaaa", undefined), null);
  assert.equal(prResolveFingerprint("", ""), null);
});

test("the fingerprint round-trips through the job row's instructions", () => {
  const fp = prResolveFingerprint("aaaaaaaaaaaa", "bbbbbbbbbbbb");
  const row = { instructions: JSON.stringify({ pr_number: 2450, resolve_fingerprint: fp }) };
  assert.equal(fingerprintOfPrResolveRow(row), fp);
});

test("a legacy row (no fingerprint) reads null rather than throwing", () => {
  assert.equal(fingerprintOfPrResolveRow({ instructions: JSON.stringify({ pr_number: 2416 }) }), null);
  assert.equal(fingerprintOfPrResolveRow({ instructions: "not json" }), null);
  assert.equal(fingerprintOfPrResolveRow({ instructions: null }), null);
});

test("THE WASTE CASE: the three #2450 rows all share one fingerprint, so a 4th is a same-input repeat", () => {
  const fp = prResolveFingerprint("2450head0000", "mainsha00000");
  const rows = [1, 2, 3].map(() => ({ instructions: JSON.stringify({ resolve_fingerprint: fp }) }));
  assert.ok(rows.every((r) => fingerprintOfPrResolveRow(r) === fp));
  // The enqueue's dedup (a) is exactly this predicate.
  assert.ok(rows.some((r) => fingerprintOfPrResolveRow(r) === fp), "same input ⇒ refuse to re-run");
});

test("THE FORECLOSURE CASE: a moved `main` is a different question and gets a fresh budget", () => {
  const spent = prResolveFingerprint("2416head0000", "oldmain00000");
  const rows = [1, 2, 3].map(() => ({
    status: "completed",
    error: null,
    instructions: JSON.stringify({ resolve_fingerprint: spent }),
  }));
  // Old behavior: lifetime count = 3 = cap ⇒ permanently exhausted.
  assert.equal(countGenuinePrResolveAttempts(rows), PR_RESOLVE_MAX_ATTEMPTS_FOR_TESTS);

  // New behavior: scope to the CURRENT input. `main` advanced ⇒ zero attempts against this pair.
  const now = prResolveFingerprint("2416head0000", "newmain00000");
  const scoped = rows.filter((r) => fingerprintOfPrResolveRow(r) === now);
  assert.equal(scoped.length, 0);
  assert.equal(countGenuinePrResolveAttempts(scoped), 0, "a genuinely new state may be attempted again");
});

test("the cap still bites WITHIN one input — an unresolvable state cannot loop", () => {
  const fp = prResolveFingerprint("headaaaaaaaa", "basebbbbbbbb");
  const rows = Array.from({ length: PR_RESOLVE_MAX_ATTEMPTS_FOR_TESTS }, () => ({
    status: "needs_attention",
    error: "advisory-supersede: 39 exported symbol(s) also appear on main",
    instructions: JSON.stringify({ resolve_fingerprint: fp }),
  }));
  const scoped = rows.filter((r) => fingerprintOfPrResolveRow(r) === fp);
  assert.ok(countGenuinePrResolveAttempts(scoped) >= PR_RESOLVE_MAX_ATTEMPTS_FOR_TESTS);
});

test("infra failures still do not burn the budget, per-input", () => {
  const fp = prResolveFingerprint("headaaaaaaaa", "basebbbbbbbb");
  const rows = [
    { status: "failed", error: "worktree add failed: ENOSPC", instructions: JSON.stringify({ resolve_fingerprint: fp }) },
    { status: "completed", error: null, instructions: JSON.stringify({ resolve_fingerprint: fp }) },
  ];
  assert.equal(countGenuinePrResolveAttempts(rows), 1, "only the real verdict counts");
});
