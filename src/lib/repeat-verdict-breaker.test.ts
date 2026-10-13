/**
 * Repeat-verdict breaker: the pure skip decision.
 *
 * Run:
 *   npx tsx --test src/lib/repeat-verdict-breaker.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideRepeatVerdict, type PriorRun } from "./repeat-verdict-breaker";

const NOW = Date.parse("2026-10-08T16:30:00Z");
const LOOP = "needs_human — ✅3 ✗0 👤1 ?0. deterministic spec-test — ✅3 ✗0 👤1 ?0 (pre-merge branch preview)";
const run = (log: string, at: string, status = "completed"): PriorRun => ({ status, log_tail: log, updated_at: at });
const loop3 = [run(LOOP, "2026-10-08T16:25:00Z"), run(LOOP, "2026-10-08T16:20:00Z"), run(LOOP, "2026-10-08T16:15:00Z")];

test("three identical verdicts inside the cooldown → skip (the 2,207-run spec-test loop)", () => {
  const d = decideRepeatVerdict({ kind: "spec-test" }, loop3, NOW, null);
  assert.equal(d.skip, true);
});

test("a different verdict in the window → run", () => {
  const runs = [loop3[0], run("approved — ✅4 ✗0", "2026-10-08T16:20:00Z"), loop3[2]];
  assert.equal(decideRepeatVerdict({ kind: "spec-test" }, runs, NOW, null).skip, false);
});

test("fewer runs than the threshold → run", () => {
  assert.equal(decideRepeatVerdict({ kind: "spec-test" }, loop3.slice(0, 2), NOW, null).skip, false);
});

test("cooldown elapsed since the newest repeat → one run goes through", () => {
  assert.equal(decideRepeatVerdict({ kind: "spec-test" }, loop3, Date.parse("2026-10-08T23:00:00Z"), null).skip, false);
});

test("a build after the newest repeat → run (the code changed)", () => {
  assert.equal(decideRepeatVerdict({ kind: "spec-test" }, loop3, NOW, "2026-10-08T16:27:00Z").skip, false);
});

test("a build before the newest repeat doesn't reset it", () => {
  assert.equal(decideRepeatVerdict({ kind: "spec-test" }, loop3, NOW, "2026-10-08T16:00:00Z").skip, true);
});

test("human-created runs are never skipped", () => {
  assert.equal(decideRepeatVerdict({ kind: "spec-test", created_by: "user-1" }, loop3, NOW, null).skip, false);
});

test("sweep kinds are out of scope", () => {
  assert.equal(decideRepeatVerdict({ kind: "platform-director" }, loop3, NOW, null).skip, false);
  assert.equal(decideRepeatVerdict({ kind: "pr-resolve" }, loop3, NOW, null).skip, false);
});

test("a failed run in the window → run (only completed repeats count)", () => {
  const runs = [loop3[0], run(LOOP, "2026-10-08T16:20:00Z", "failed"), loop3[2]];
  assert.equal(decideRepeatVerdict({ kind: "spec-test" }, runs, NOW, null).skip, false);
});

test("blank verdict lines never match", () => {
  const blank = [run("", "2026-10-08T16:25:00Z"), run("", "2026-10-08T16:20:00Z"), run("", "2026-10-08T16:15:00Z")];
  assert.equal(decideRepeatVerdict({ kind: "spec-test" }, blank, NOW, null).skip, false);
});
