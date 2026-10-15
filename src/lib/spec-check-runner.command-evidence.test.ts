import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCommandFailure } from "./spec-check-runner";

// 2026-10-14/15: close-snapshot-coverage-guard failed `test:all` three times and the evidence was the
// first 4000 chars of output — all passing lines — so nobody could see which test failed.
test("summarizeCommandFailure surfaces the failing test from a long suite run", () => {
  const passing = Array.from({ length: 3000 }, (_, i) => `ok ${i + 1} - passes ${i}`).join("\n");
  const out = `${passing}\nnot ok 3001 - spawnPreMergeFix mixed case\n  ---\n  error: 'expected spawn threw'\n  location: 'src/lib/pre-merge-fix.test.ts:62:1'\n  ...\n${passing}\n# tests 6001\n# pass 6000\n# fail 1`;
  const ev = summarizeCommandFailure(out);
  assert.ok(ev.length <= 4000);
  assert.match(ev, /not ok 3001 - spawnPreMergeFix mixed case/);
  assert.match(ev, /pre-merge-fix\.test\.ts:62/);
  assert.match(ev, /# fail 1/);
});

test("summarizeCommandFailure returns short output whole (harness signatures stay intact)", () => {
  const out = `npm error Missing script: "test:nope"`;
  assert.equal(summarizeCommandFailure(out), out);
});

test("summarizeCommandFailure with no failing-test lines keeps the tail, not the head", () => {
  const out = "x".repeat(10000) + "\nFATAL: the real error";
  assert.match(summarizeCommandFailure(out), /FATAL: the real error/);
});
