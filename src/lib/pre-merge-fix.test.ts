/**
 * vera-harness-error-is-not-a-code-regression Phase 2 — the belt-and-suspenders guard on the
 * pre-merge fix-phase authoring path. `spawnPreMergeFix` MUST NOT author a Bo fix phase for a run
 * whose only failing checks are HARNESS/COMMAND signatures (missing npm script, command-not-found,
 * ENOENT, missing binary) — a harness fail never ran an assertion, so it isn't a code regression;
 * appending a Fix phase for it wedges the origin's build chain (the 2026-07-11 cs-director-leash
 * false-regression).
 *
 * Phase 1's normalizer downgrades these to `needs_human` before they reach `spawnPreMergeFix`, but
 * this test pins the belt-and-suspenders at THIS gate: even if a legacy `spec_test_runs` row or a
 * race hands a harness `fail` down, spawn returns without authoring anything.
 *
 * The harness-only + mixed cases short-circuit BEFORE any admin/DB calls, so no Supabase mock is
 * required — the guard is purely predicate-driven.
 *
 * Run:
 *   npx tsx --test src/lib/pre-merge-fix.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnPreMergeFix, type SpawnPreMergeFixInput } from "./pre-merge-fix";

// Any admin token — the harness-only guard returns BEFORE reading it. When the guard misfires, this
// stub throws so the test fails loud rather than silently DB-writing.
const throwOnUse = new Proxy({}, {
  get() {
    throw new Error("admin should not be touched — the harness guard must return before any DB call");
  },
}) as never;

const baseInput = (overrides: Partial<SpawnPreMergeFixInput>): SpawnPreMergeFixInput => ({
  workspaceId: "00000000-0000-0000-0000-000000000000",
  originSlug: "cs-director-leash-categories",
  originTitle: "cs-director-leash-categories",
  branch: "claude/build-cs-director-leash-categories",
  failing: [],
  ...overrides,
});

test("spawnPreMergeFix DROPS the exact cs-director-leash motivating harness fail — nothing authored", async () => {
  const input = baseInput({
    failing: [
      {
        text: "the test file passes: npm test src/lib/agents/cs-director.test.ts",
        check_key: "harness-cs-director",
        evidence: `npm error Missing script: "test"\nExit code: 1`,
      },
    ],
  });
  const out = await spawnPreMergeFix(throwOnUse, input);
  assert.equal(out.spawned, false, "a harness-only run must NEVER spawn a Bo fix phase");
  assert.equal(out.escalated, false, "harness-only is not an escalation — it's a verification-authoring wart");
  if (!out.spawned && !out.escalated) {
    assert.match(
      out.reason,
      /no evidence-backed failing checks/i,
      "the reason must name the empty-failing-set state, not silently return spawned:true",
    );
  }
});

test("spawnPreMergeFix drops harness fails but STILL authors a fix phase for a real code fail", async (t) => {
  // The mixed case needs at least one genuine code fail to survive, and once one does the function
  // walks the getSpec path. Assert the FILTER shape (via export) rather than mocking the whole SDK:
  // we already prove the harness-only case above; here we prove a mixed set does NOT short-circuit
  // on the empty-guard. If a real fail survives the filter, spawnPreMergeFix will attempt getSpec —
  // and getSpec against this fake admin throws. So the assertion is: it throws AFTER the guard, not
  // BEFORE. That is the correct behaviour (the harness fail is dropped; the real fail is kept and
  // reaches the DB layer).
  const input = baseInput({
    failing: [
      {
        text: "harness bullet",
        check_key: "harness-key",
        evidence: `npm error Missing script: "test"`,
      },
      {
        text: "real assertion fails: expected 'active' got 'canceled'",
        check_key: "real-code-key",
        evidence: `AssertionError: "active" !== "canceled" at src/lib/foo.test.ts:42:3`,
      },
    ],
  });
  const out = await spawnPreMergeFix(throwOnUse, input);
  // spawnPreMergeFix's outer try/catch converts a downstream throw into
  // `{ spawned:false, escalated:false, reason: "spawn threw: ..." }`. The key signal for this test
  // is that the reason is NOT the harness empty-guard — that would mean the real fail got filtered
  // too. Any downstream throw (proxy trap OR supabase client construction) proves the real fail
  // survived the filter and reached the DB layer.
  assert.equal(out.spawned, false);
  assert.equal(out.escalated, false);
  if (!out.spawned && !out.escalated) {
    assert.match(
      out.reason,
      /^spawn threw:/,
      "the real code fail must survive the harness filter and reach the DB layer (throws in test env)",
    );
    assert.doesNotMatch(
      out.reason,
      /no evidence-backed failing checks/,
      "with a real code fail present, the empty-failing-set short-circuit must NOT fire",
    );
  }
  t.diagnostic("harness fail dropped; real code fail survived to reach getSpec");
});

test("spawnPreMergeFix returns the empty-guard reason for a genuinely empty input", async () => {
  const input = baseInput({ failing: [] });
  const out = await spawnPreMergeFix(throwOnUse, input);
  assert.equal(out.spawned, false);
  assert.equal(out.escalated, false);
  if (!out.spawned && !out.escalated) {
    assert.match(out.reason, /no evidence-backed failing checks/i);
  }
});
