/**
 * Unit test for reap-needs-attention-jobs-for-archived-specs Phase 2 — the platform-director standing-
 * pass stuck-build lister filters out a `build`/`spec-test` parked/stalled job whose spec is TERMINAL
 * (folded). Belt-and-suspenders for the [[agent-jobs]] Phase 1 reaper widening: even in the window
 * between a spec folding and the next builder-worker reaper sweep, `platformHasPendingWork` (and the
 * standing-pass lister sharing its predicate) must NOT re-flag the shipped spec as stuck.
 *
 *   npm run test:stuck-build-terminal-spec
 *   (= tsx --test src/lib/agents/platform-director.stuck-build-terminal-spec.test.ts)
 *
 * Covers the spec's Verification bullets:
 *   - "platformHasPendingWork / the stuck-build lister does not include a job whose spec is folded"
 *   - "a live-spec needs_attention job is still reported"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filterStuckJobsForTerminalSpecs } from "./platform-director";

interface FakeJob {
  id: string;
  kind: string;
  spec_slug: string | null;
}

test("a folded-spec build parked in needs_attention is FILTERED OUT (the root fix)", () => {
  const jobs: FakeJob[] = [
    { id: "j-folded-build", kind: "build", spec_slug: "director-sms-cockpit-per-director" },
  ];
  const terminal = new Set(["director-sms-cockpit-per-director"]);
  const out = filterStuckJobsForTerminalSpecs(jobs, terminal);
  assert.deepEqual(out, []);
});

test("a folded-spec spec-test job is also filtered out (both build kinds are reap-covered)", () => {
  const jobs: FakeJob[] = [
    { id: "j-folded-spec-test", kind: "spec-test", spec_slug: "claim-rpc-kill-switch-enforcement" },
  ];
  const terminal = new Set(["claim-rpc-kill-switch-enforcement"]);
  const out = filterStuckJobsForTerminalSpecs(jobs, terminal);
  assert.deepEqual(out, []);
});

test("a LIVE-spec build parked in needs_attention IS kept (surfaced as a stuck build)", () => {
  const jobs: FakeJob[] = [
    { id: "j-live-build", kind: "build", spec_slug: "still-building-spec" },
  ];
  const terminal = new Set(["something-else-folded"]);
  const out = filterStuckJobsForTerminalSpecs(jobs, terminal);
  assert.deepEqual(out.map((j) => j.id), ["j-live-build"]);
});

test("a non-build/spec-test parked job (e.g. ticket-handle) is ALWAYS kept — reaper doesn't touch it", () => {
  const jobs: FakeJob[] = [
    { id: "j-ticket", kind: "ticket-handle", spec_slug: null },
    { id: "j-repair", kind: "repair", spec_slug: "some-folded-spec" },
  ];
  const terminal = new Set(["some-folded-spec"]);
  const out = filterStuckJobsForTerminalSpecs(jobs, terminal);
  assert.deepEqual(out.map((j) => j.id).sort(), ["j-repair", "j-ticket"].sort());
});

test("a build/spec-test job with NO spec_slug is kept (no terminal-spec lookup possible → surface)", () => {
  const jobs: FakeJob[] = [
    { id: "j-orphan", kind: "build", spec_slug: null },
  ];
  const terminal = new Set(["any-folded-spec"]);
  const out = filterStuckJobsForTerminalSpecs(jobs, terminal);
  assert.deepEqual(out.map((j) => j.id), ["j-orphan"]);
});

test("mixed: folded-spec build + live-spec build + non-build → only the folded-spec build filtered out", () => {
  const jobs: FakeJob[] = [
    { id: "j-folded", kind: "build", spec_slug: "recently-folded" },
    { id: "j-live", kind: "build", spec_slug: "still-alive" },
    { id: "j-ticket", kind: "ticket-handle", spec_slug: null },
  ];
  const terminal = new Set(["recently-folded"]);
  const out = filterStuckJobsForTerminalSpecs(jobs, terminal);
  assert.deepEqual(out.map((j) => j.id).sort(), ["j-live", "j-ticket"].sort());
});

test("empty terminal-spec set = no filtering (every job survives)", () => {
  const jobs: FakeJob[] = [
    { id: "j-build", kind: "build", spec_slug: "any-slug" },
    { id: "j-spec-test", kind: "spec-test", spec_slug: "other-slug" },
  ];
  const out = filterStuckJobsForTerminalSpecs(jobs, new Set<string>());
  assert.deepEqual(out.map((j) => j.id).sort(), ["j-build", "j-spec-test"].sort());
});

test("empty jobs list = empty output (no-op is safe)", () => {
  const out = filterStuckJobsForTerminalSpecs<FakeJob>([], new Set(["anything"]));
  assert.deepEqual(out, []);
});
