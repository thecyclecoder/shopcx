/**
 * pr-resolve-park-clears-on-pr-merged — regression coverage for the pure decision helper the
 * stale-park reconciler uses to decide whether a pr-resolve park card can auto-clear. The 2026-07-02
 * incident (PR #1010 human-merged at 19:42, park card still live 22 min later, cleared only by a
 * manual DB edit) hinged on this predicate being CONSERVATIVE: clear on a positively-observed
 * merged/closed PR, keep the card on a still-open PR or a failed GitHub read.
 *
 * Built-in node:test — run: tsx --test src/lib/agents/approval-inbox-pr-resolve-park.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prResolveParkOutcome } from "./approval-inbox";

test("PR merged ⇒ clear with outcome='merged' (the pr-1010 case)", () => {
  const r = prResolveParkOutcome({ ok: true, merged: true, state: "closed", closedAt: "2026-07-02T19:42:00Z" });
  assert.deepEqual(r, { action: "clear", outcome: "merged" });
});

test("PR closed without merging (human closed the branch) ⇒ clear with outcome='closed'", () => {
  const r = prResolveParkOutcome({ ok: true, merged: false, state: "closed", closedAt: "2026-07-02T19:42:00Z" });
  assert.deepEqual(r, { action: "clear", outcome: "closed" });
});

test("PR still open+dirty (state='open', not merged) ⇒ KEEP the card", () => {
  const r = prResolveParkOutcome({ ok: true, merged: false, state: "open", closedAt: null });
  assert.deepEqual(r, { action: "keep", reason: "still_open" });
});

test("GitHub read failure (`{ok:false}`) ⇒ KEEP (CONSERVATIVE: never clear on a null read)", () => {
  const r = prResolveParkOutcome({ ok: false });
  assert.deepEqual(r, { action: "keep", reason: "read_failed" });
});

test("merged flag WINS even if state somehow reports 'open' (defensive — merged is the ground truth)", () => {
  // Real GitHub payloads flip state='closed' when merged=true, but the guard should not depend on
  // that invariant: a merged PR is done, full stop.
  const r = prResolveParkOutcome({ ok: true, merged: true, state: "open", closedAt: null });
  assert.deepEqual(r, { action: "clear", outcome: "merged" });
});
