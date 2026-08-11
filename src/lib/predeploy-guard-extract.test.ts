/**
 * Unit tests for `extractFailedPredeployGuards` — predeploy-gate-repairs-in-session.
 *
 * WHY THIS TEST EXISTS. The prior extractor was a single `/❌\s*(check-[^\s—]+)/` and it silently failed
 * the common case: the ~21 guards in the `predeploy:static` chain do NOT share one output format. On
 * 2026-08-10, 4 of the 6 builds that parked on this gate reported the literal string "unknown check" — the
 * CEO got a park with no remediation and the retry had nothing new to act on. A wrong-but-plausible regex
 * reads as working, so each real output shape observed in the wild is pinned here.
 *
 * Run:  npx tsx --test src/lib/predeploy-guard-extract.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractFailedPredeployGuards } from "./predeploy-guard-extract";

test("shape (a) — a guard's own ❌ line names the guard", () => {
  const out = `
> shopcx-init@0.1.0 check:rls-on-new-tables
> tsx scripts/_check-rls-on-new-tables.ts

❌ check-rls-on-new-tables — table "public.foo" has no RLS policy. Add one in the migration.
`;
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-rls-on-new-tables"]);
});

test("shape (b) — npm's lifecycle frame is enough when the guard prints no ❌ slug", () => {
  const out = `
npm error Lifecycle script \`check:node-registry-drift\` failed with error:
npm error code 1
`;
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-node-registry-drift"]);
});

test("shape (c) — a scripts/_check-*.ts path in a stack trace names the guard", () => {
  const out = `
Error: ENOENT: no such file or directory
    at Object.readFileSync (node:fs:1234:5)
    at main (/repo/scripts/_check-tests-registered.ts:88:11)
`;
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-tests-registered"]);
});

test("normalizes npm's `check:foo` onto the guards' own `check-foo` form (one entry, not two)", () => {
  const out = `
npm error Lifecycle script \`check:box-types\` failed with error:
❌ check-box-types — builder-worker.ts failed to typecheck
`;
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-box-types"]);
});

test("returns EVERY distinct guard, in first-seen order", () => {
  // NB: the remediation text here is deliberately paraphrased rather than quoting a real raw-write
  // snippet — `check-pm-sdk-compliance` scans source TEXT, so pasting a literal
  // `.from(<pm-table>).update()` into this fixture makes the guard flag this test file itself.
  const out = `
❌ check-pm-sdk-compliance — raw PM-table write outside the SDK at src/lib/x.ts:12
❌ check-no-lossy-error-stringify — lossy error stringify at src/lib/y.ts:44
❌ check-pm-sdk-compliance — raw PM-table write outside the SDK at src/lib/z.ts:9
`;
  assert.deepEqual(extractFailedPredeployGuards(out), [
    "check-pm-sdk-compliance",
    "check-no-lossy-error-stringify",
  ]);
});

test("strips trailing punctuation so `check-foo.` and `check-foo` are one guard", () => {
  const out = `❌ check-worker-lanes.\n❌ check-worker-lanes — a lane has no owner`;
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-worker-lanes"]);
});

test("genuinely unattributable output returns EMPTY — never a fabricated guard name", () => {
  // The caller renders "unattributable guard (see log_tail)". The property that matters is that we never
  // INVENT a name, which would send Bo's repair pass at the wrong file.
  const out = "npm error code 1\nnpm error path /repo\nsome unrelated failure";
  assert.deepEqual(extractFailedPredeployGuards(out), []);
});

test("does not match a bare word that merely contains 'check'", () => {
  const out = "Running prechecks…\nchecking things\nall checks ran";
  assert.deepEqual(extractFailedPredeployGuards(out), []);
});

test("the real-world 2026-08-10 park output is now attributable (was 'unknown check')", () => {
  // Shape taken from the ticket-direction-path-workflow-enum-drift park: the guard names itself, but the
  // old regex's `[^\s—]+` swallowed the em-dash-adjacent token and missed multi-guard output entirely.
  const out = `
> shopcx-init@0.1.0 check:ticket-direction-path-drift
> tsx scripts/_check-ticket-direction-path-drift.ts

❌ check-ticket-direction-path-drift — 'workflow' missing from the ticket_direction_path enum
npm error Lifecycle script \`check:ticket-direction-path-drift\` failed with error:
`;
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-ticket-direction-path-drift"]);
});
