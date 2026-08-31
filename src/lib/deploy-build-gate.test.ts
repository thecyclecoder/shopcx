/**
 * Unit tests for the deploy build gate (a-red-main-is-a-first-class-pipeline-alarm Phase 2).
 *
 * Node's built-in `node:test` — no test-runner dependency. Run:
 *   npx tsx --test src/lib/deploy-build-gate.test.ts
 *
 * Pins the load-bearing asymmetry the spec calls out: the gate blocks ONLY on the
 * cacheComponents/prerender class it was written for; a compile / module / binary infra failure
 * is treated as noise (NOT the author's code — bouncing it back would loop forever). BOTH
 * behaviours must stay pinned, in ONE place — both the box lane's build gate AND the auto-merge
 * chokepoint route through `classifyBuildGateOutput`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_GATE_BLOCK_RE,
  BUILD_GATE_PATH_RE,
  classifyBuildGateOutput,
  shouldRunBuildGate,
} from "./deploy-build-gate";

test("exit 0 → pass (never look at the output)", () => {
  const r = classifyBuildGateOutput(0, "irrelevant garbage that would otherwise match anything");
  assert.equal(r.pass, true);
  assert.equal(r.error, "");
});

test("BLOCK: 'Uncached data was accessed outside of <Suspense>' fails the gate", () => {
  const out = "some noise\nError: Route \"/dashboard/roadmap\": Uncached data was accessed outside of <Suspense> boundary.\nmore noise\n";
  const r = classifyBuildGateOutput(1, out);
  assert.equal(r.pass, false);
  assert.match(r.error, /Route "\/dashboard\/roadmap"/);
});

test("BLOCK: 'Error occurred prerendering page' fails the gate", () => {
  const out = "noise\nError occurred prerendering page \"/some/route\". More text.\n";
  const r = classifyBuildGateOutput(1, out);
  assert.equal(r.pass, false);
  assert.match(r.error, /Error occurred prerendering page/);
});

test("BLOCK: 'Export encountered an error' fails the gate", () => {
  const out = "log log log\nExport encountered an error on /foo\nadditional lines\n";
  const r = classifyBuildGateOutput(1, out);
  assert.equal(r.pass, false);
  assert.match(r.error, /Export encountered an error/);
});

test("BLOCK: 'Route segment config … not compatible' fails the gate", () => {
  const out = "noise\nRoute segment config `runtime` is not compatible with cacheComponents\n";
  const r = classifyBuildGateOutput(1, out);
  assert.equal(r.pass, false);
  assert.match(r.error, /Route segment config/);
});

test("NON-BLOCK: a bare compile error is INFRA noise, not the author's code — passes", () => {
  const out =
    "Type error: Cannot find module 'ffmpeg-static' or its corresponding type declarations.\n" +
    "  1 | import ffmpeg from 'ffmpeg-static'\n";
  const r = classifyBuildGateOutput(1, out);
  assert.equal(r.pass, true, "a module-missing infra error must NOT block the merge");
  assert.equal(r.error, "");
});

test("NON-BLOCK: an npm/binary transient is infra noise — passes (asymmetry preserved)", () => {
  const out = "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\nnpm ERR! next-app@ build: `next build`\n";
  const r = classifyBuildGateOutput(1, out);
  assert.equal(r.pass, true);
});

test("BUILD_GATE_BLOCK_RE covers ALL four block phrases (regression-pinned)", () => {
  assert.ok(BUILD_GATE_BLOCK_RE.test("Uncached data was accessed outside of <Suspense>"));
  assert.ok(BUILD_GATE_BLOCK_RE.test("Error occurred prerendering page"));
  assert.ok(BUILD_GATE_BLOCK_RE.test("Export encountered an error"));
  assert.ok(BUILD_GATE_BLOCK_RE.test("Route segment config `runtime` is not compatible"));
});

test("shouldRunBuildGate: fires on src/app/ / src/components/ / next.config / middleware.", () => {
  assert.ok(shouldRunBuildGate("src/app/dashboard/page.tsx\nother.md\n"));
  assert.ok(shouldRunBuildGate("docs/foo.md\nsrc/components/Widget.tsx\n"));
  assert.ok(shouldRunBuildGate("next.config.ts\n"));
  assert.ok(shouldRunBuildGate("middleware.ts\n"));
  assert.ok(!shouldRunBuildGate("docs/brain/foo.md\nscripts/x.ts\nsrc/lib/y.ts\n"));
});

test("BUILD_GATE_PATH_RE anchors properly (never matches mid-line/false-positive)", () => {
  // A `src/app/…` mid-line (not at start-of-string or after a newline) MUST NOT match — the regex
  // is anchored on `(?:^|\n)` and the callers pass the raw `git diff --name-only` output which is
  // newline-delimited.
  assert.ok(!BUILD_GATE_PATH_RE.test("scripts/reference/src/app/foo.ts\n"));
  assert.ok(BUILD_GATE_PATH_RE.test("src/app/foo.ts\n"));
  assert.ok(BUILD_GATE_PATH_RE.test("docs/x.md\nsrc/app/foo.ts\n"));
});
