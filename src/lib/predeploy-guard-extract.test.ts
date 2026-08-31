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
import {
  classifyPredeployViolationScope,
  extractFailedPredeployGuards,
  extractPredeployViolationPaths,
} from "./predeploy-guard-extract";

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

// ── shape (0): npm's per-script echo wins, so the chain HEADER can't name all 21 guards ──
// The CEO-inbox signal-to-noise hot fix (2026-08-11). `predeploy:static` chains its guards with
// `&&`, so npm first echoes the whole chain as one header line — which shape (b)'s `npm run` pattern
// matched, returning EVERY guard in the chain as "failing". That string lands in `agent_jobs.error`
// (what the needs-attention classifier buckets on) and would point a repair pass at 21 files.

test("shape (0) — the &&-chain HEADER does not turn every chained guard into a failure", () => {
  const out = `
> shopcx-init@0.1.0 predeploy:static
> npm run check:worker-lanes && npm run check:pm-sdk-compliance && npm run check:node-registry-drift

> shopcx-init@0.1.0 check:worker-lanes
> tsx scripts/_check-worker-lanes.ts

all lanes accounted for

> shopcx-init@0.1.0 check:node-registry-drift
> tsx scripts/_check-node-registry-drift.ts

drift: 'foo' has no OwnerFunction
npm error code 1
`;
  // npm stops at the first failure, so the LAST echoed script is the one that broke.
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-node-registry-drift"]);
});

test("shape (0) — the per-script echo is normalized onto the `check-foo` form", () => {
  const out = "> shopcx-init@0.1.0 check:rls-on-new-tables\n> tsx scripts/_check-rls-on-new-tables.ts\n\nboom\n";
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-rls-on-new-tables"]);
});

test("shape (0) — absent the echo, the (a)/(b)/(c) union is unchanged", () => {
  const out = "❌ check-box-types — tsc failed on the box entrypoint\n";
  assert.deepEqual(extractFailedPredeployGuards(out), ["check-box-types"]);
});

// ── extractPredeployViolationPaths ──

test("extractPredeployViolationPaths — real competitors-sdk-compliance failure names the three _kcups files", () => {
  // Modelled on the actual 2026-08-31 park output: the guard prints one line per finding via the `•`
  // shape (see scripts/_check-competitors-sdk-compliance.ts:121). This is the exact case that had two
  // concurrent unrelated builds racing to author the same fix on files neither spec was about.
  // Snippet TEXT after each `→` is paraphrased on purpose. The extractor only reads `{file}:{line}`
  // before the `→` (see extractPredeployViolationPaths shapes a+b), so the snippet is decorative.
  // Quoting a literal competitors-table write here would make check-competitors-sdk-compliance flag
  // this test file itself — same paraphrase-your-fixtures trap the sibling PM guard hit and the
  // existing `returns EVERY distinct guard` fixture already documents.
  const out = `
> shopcx-init@0.1.0 check:competitors-sdk-compliance
> tsx scripts/_check-competitors-sdk-compliance.ts

❌ check-competitors-sdk-compliance — 3 raw competitors-table writes outside the SDK:

  • scripts/_kcups-blockers.ts:44  →  raw competitors-table select outside the SDK
  • scripts/_kcups-competitors.ts:81  →  raw competitors-table upsert outside the SDK
  • scripts/_kcups-readiness.ts:12  →  raw competitors-table select outside the SDK
`;
  assert.deepEqual(extractPredeployViolationPaths(out), [
    "scripts/_kcups-blockers.ts",
    "scripts/_kcups-competitors.ts",
    "scripts/_kcups-readiness.ts",
  ]);
});

test("extractPredeployViolationPaths — [VIOLATION] shape from the summary path is picked up too", () => {
  // The same guard emits a `[VIOLATION]` line via its summary block (scripts/_check-competitors-sdk-
  // compliance.ts:113). Both shapes must resolve — mixing them in one output should still dedupe.
  // Snippet text after the file:line is paraphrased for the same reason as the fixture above.
  const out = `
competitors-SDK-compliance — 12 file(s) scanned, 2 raw competitors-table findings
  [VIOLATION] src/lib/foo.ts:44  raw competitors-table select outside the SDK
  [VIOLATION] scripts/_bar.ts:9  raw competitors-table upsert outside the SDK

❌ check-competitors-sdk-compliance — 2 raw competitors-table writes outside the SDK:

  • src/lib/foo.ts:44  →  raw competitors-table select outside the SDK
  • scripts/_bar.ts:9  →  raw competitors-table upsert outside the SDK
`;
  assert.deepEqual(extractPredeployViolationPaths(out), [
    "src/lib/foo.ts",
    "scripts/_bar.ts",
  ]);
});

test("extractPredeployViolationPaths — ignores the `> tsx scripts/_check-foo.ts` npm lifecycle frame", () => {
  // The guard's OWN runner line contains `scripts/…`. Without the lifecycle-frame skip the extractor
  // would report the guard as its own violation and the repair pass would target the wrong file — the
  // exact class of bug `extractFailedPredeployGuards`'s `lastEcho` precedence rule already defends
  // against. Snippet paraphrased per the note on the fixture above.
  const out = `
> shopcx-init@0.1.0 check:competitors-sdk-compliance
> tsx scripts/_check-competitors-sdk-compliance.ts

  • src/lib/real-owner.ts:12  →  raw competitors-table select outside the SDK
`;
  assert.deepEqual(extractPredeployViolationPaths(out), ["src/lib/real-owner.ts"]);
});

test("extractPredeployViolationPaths — unattributable output returns EMPTY (fails-closed at the caller)", () => {
  const out = "npm error code 1\nnpm error path /repo\nsome unrelated failure\n";
  assert.deepEqual(extractPredeployViolationPaths(out), []);
});

// ── classifyPredeployViolationScope ──

test("classifyPredeployViolationScope — every extracted path is inherited from main → allInherited", () => {
  // Ground truth: the 2026-08-31 park. cold-scaler-arming-decides-on-evidence-not-absence's diff did not
  // touch any _kcups file, yet the competitors SDK guard demanded a repair on all three of them because a
  // separate PR had introduced them on main. Classification MUST say "inherited" and the repair loop must
  // step aside.
  // Snippet paraphrased per the note on the extractPredeployViolationPaths kcups fixture above.
  const out = `
❌ check-competitors-sdk-compliance — 3 raw competitors-table writes outside the SDK:

  • scripts/_kcups-blockers.ts:44  →  raw competitors-table select outside the SDK
  • scripts/_kcups-competitors.ts:81  →  raw competitors-table upsert outside the SDK
  • scripts/_kcups-readiness.ts:12  →  raw competitors-table select outside the SDK
`;
  const changedPaths = [
    "src/lib/cold-scaler.ts",
    "src/lib/inngest/cold-scaler-tick.ts",
  ];
  const r = classifyPredeployViolationScope({ out, changedPaths });
  assert.deepEqual(r.owned, []);
  assert.deepEqual(r.inherited, [
    "scripts/_kcups-blockers.ts",
    "scripts/_kcups-competitors.ts",
    "scripts/_kcups-readiness.ts",
  ]);
  assert.equal(r.allInherited, true);
});

test("classifyPredeployViolationScope — the branch touched the violating file → owned, allInherited=false", () => {
  // Snippet TEXT is paraphrased on purpose — the extractor only reads `{file}:{line}` before the `→`.
  // Quoting a literal `.from('<pm-table>').update(...)` here would make check-pm-sdk-compliance flag
  // this test file itself (same trap the `returns EVERY distinct guard` fixture defends against).
  const out = `❌ check-pm-sdk-compliance — raw PM-table write outside the SDK\n  • src/lib/x.ts:12  →  raw PM-table update outside the SDK\n`;
  const r = classifyPredeployViolationScope({
    out,
    changedPaths: ["src/lib/x.ts", "docs/brain/libraries/x.md"],
  });
  assert.deepEqual(r.owned, ["src/lib/x.ts"]);
  assert.deepEqual(r.inherited, []);
  assert.equal(r.allInherited, false);
});

test("classifyPredeployViolationScope — mixed owned + inherited → allInherited=false (repair proceeds)", () => {
  // See paraphrase note on the owned-only case above.
  const out = `
❌ check-pm-sdk-compliance — 2 raw PM-table writes outside the SDK:

  • src/lib/x.ts:12  →  raw PM-table update outside the SDK
  • src/lib/legacy-untouched.ts:44  →  raw PM-table delete outside the SDK
`;
  const r = classifyPredeployViolationScope({
    out,
    changedPaths: ["src/lib/x.ts"],
  });
  assert.deepEqual(r.owned, ["src/lib/x.ts"]);
  assert.deepEqual(r.inherited, ["src/lib/legacy-untouched.ts"]);
  // The branch genuinely owns part of it, so the repair loop must run — the load-bearing property is
  // that a mixed result stays repairable, not gets skipped.
  assert.equal(r.allInherited, false);
});

test("classifyPredeployViolationScope — unparseable output falls back to allInherited=false (fail-closed)", () => {
  // The load-bearing rule of the phase: a guard whose output we could not parse into any path must NOT
  // be treated as "nothing this branch owns" — the caller's contract is that allInherited=false ⇒
  // repair as today. Silently skipping a real violation would be strictly worse than a redundant repair.
  const out = "npm error code 1\nnpm error path /repo\nsome opaque stack trace\n";
  const r = classifyPredeployViolationScope({
    out,
    changedPaths: ["src/lib/whatever.ts"],
  });
  assert.deepEqual(r.paths, []);
  assert.deepEqual(r.owned, []);
  assert.deepEqual(r.inherited, []);
  assert.equal(r.allInherited, false);
});

test("classifyPredeployViolationScope — normalization: leading `./` and backslashes match cross-shape", () => {
  const out = `❌ check-pm-sdk-compliance\n  • src/lib/x.ts:12  →  raw PM-table update outside the SDK\n`;
  // changedPaths as git-diff might present them on a Windows checkout or a `./`-prefixed diff; both
  // should compare equal after normalization.
  const r = classifyPredeployViolationScope({
    out,
    changedPaths: ["./src\\lib\\x.ts"],
  });
  assert.deepEqual(r.owned, ["src/lib/x.ts"]);
  assert.deepEqual(r.inherited, []);
  assert.equal(r.allInherited, false);
});
