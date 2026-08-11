/**
 * Unit tests for `nextPhaseToBuild` — the chain-advance selector behind `queueNextChainedPhase`.
 *
 * THE WEDGE THIS PINS (2026-08-11). The selector used to be `phases.find(p => p.status === "planned")`.
 * A phase that is BUILT-BUT-UNSTAMPED (`build_sha` set, `status` still `planned` — routine drift in the
 * branch flow, since `stampPhaseBuilt` and the status write are separate) was therefore picked as "next"
 * on EVERY pass. `queueNextChainedPhase`'s dedup then found the build job already carrying that phase's
 * scoped instructions and returned null — so the chain never advanced and every LATER phase was
 * unreachable, permanently.
 *
 * Live case: `swap-variant-self-heal-…` (PR #2438) — P1 `planned` with `build_sha=89ad4077`, P2 a security
 * Fix phase appended by `spawnPreMergeFix`. The fix phase could never build; the PR sat 19h. The restored
 * fixes-as-phases path appended the phase correctly and then had no way to finish it.
 *
 * Run:  npx tsx --test src/lib/agent-jobs.chain-advance-selector.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { nextPhaseToBuild } from "./agent-jobs";

type P = { title: string; status: string; build_sha?: string | null };

test("THE WEDGE: a built-but-unstamped planned phase is SKIPPED, so a later fix phase is reachable", () => {
  // The exact PR #2438 shape.
  const phases: P[] = [
    { title: "P1 — implement the fix", status: "planned", build_sha: "89ad407784384e9cd8700d5efae6c80a624ab05e" },
    { title: "Fix 1 — resolve 1 pre-merge spec-test regression", status: "planned", build_sha: null },
  ];
  assert.equal(nextPhaseToBuild(phases)?.title, "Fix 1 — resolve 1 pre-merge spec-test regression");
});

test("a genuinely un-built planned phase is still selected (normal chain advance)", () => {
  const phases: P[] = [
    { title: "P1", status: "shipped", build_sha: "aaa" },
    { title: "P2", status: "planned", build_sha: null },
    { title: "P3", status: "planned", build_sha: null },
  ];
  assert.equal(nextPhaseToBuild(phases)?.title, "P2", "picks the FIRST un-built planned phase, in order");
});

test("all phases built or terminal → undefined (the chain is complete)", () => {
  const phases: P[] = [
    { title: "P1", status: "shipped", build_sha: "aaa" },
    { title: "P2", status: "planned", build_sha: "bbb" }, // built, awaiting stamp
  ];
  assert.equal(nextPhaseToBuild(phases), undefined);
});

test("a non-planned phase is never selected regardless of build_sha", () => {
  const phases: P[] = [
    { title: "P1", status: "in_progress", build_sha: null },
    { title: "P2", status: "rejected", build_sha: null },
    { title: "P3", status: "planned", build_sha: null },
  ];
  assert.equal(nextPhaseToBuild(phases)?.title, "P3");
});

test("an empty build_sha string counts as un-built (falsy), not as built", () => {
  const phases: P[] = [{ title: "P1", status: "planned", build_sha: "" }];
  assert.equal(nextPhaseToBuild(phases)?.title, "P1");
});

test("a missing build_sha field (undefined) counts as un-built", () => {
  const phases: P[] = [{ title: "P1", status: "planned" }];
  assert.equal(nextPhaseToBuild(phases)?.title, "P1");
});

test("empty phase list → undefined (no throw)", () => {
  assert.equal(nextPhaseToBuild([]), undefined);
});
