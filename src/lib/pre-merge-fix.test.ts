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
  // Make the DB layer unreachable so getSpec cannot succeed: strip the Supabase env so
  // createAdminClient throws. This forces the deterministic "spawn threw" outcome in a hermetic env.
  // NOTE: node:test runs test FILES concurrently and this mutates GLOBAL process.env, so the strip
  // is best-effort — a sibling file running at the same instant can leave the real URL visible, in
  // which case getSpec reaches PROD and returns "origin spec … not found" instead of throwing. That
  // raced false-red made test:all flap only on the box and failed every build whose check runs the
  // whole suite (close-snapshot-coverage-guard, 2026-10-14). The assertion below therefore accepts
  // BOTH DB-layer outcomes — a thrown client-construction error OR a "spec not found" read — because
  // EITHER proves the real fail survived the harness filter and reached the DB layer, which is the
  // actual invariant under test. What it must NEVER be is the empty-failing-set short-circuit.
  const saved: Record<string, string | undefined> = {};
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });
  const out = await spawnPreMergeFix(throwOnUse, input);
  assert.equal(out.spawned, false);
  assert.equal(out.escalated, false);
  if (!out.spawned && !out.escalated) {
    assert.match(
      out.reason,
      /^spawn threw:|not found — cannot append fix phase/,
      "the real code fail must survive the harness filter and reach the DB layer (throws, or reads 'spec not found' when the env leaks)",
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
