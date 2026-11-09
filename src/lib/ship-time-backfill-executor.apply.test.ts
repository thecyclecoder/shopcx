/**
 * Unit tests for the ship-time-backfill executor's APPLY contract —
 * ship-time-backfill-executor-passes-apply Phase 1.
 *
 * The bug: `executeShipTimeBackfillsForSpec` spawned `npx tsx -- <script>` with NO `--apply`, so
 * the 42-of-55 backfill scripts that are dry-run-by-default only dry-ran and the ledger still
 * recorded them `ran` — a silent no-op masquerading as a completed data-op. These tests pin the
 * now-load-bearing argv/env/stdout contract (pure functions, no process spawned).
 *
 * Run:  npx tsx --test src/lib/ship-time-backfill-executor.apply.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBackfillArgv,
  buildBackfillEnv,
  isDryRunStdout,
  isValidScriptPathForExec,
} from "./ship-time-backfill-executor";

test("the spawn argv carries --apply after the script path, behind a `--` separator", () => {
  const argv = buildBackfillArgv("scripts/_backfill-foo.ts");
  assert.deepEqual(argv, ["tsx", "--", "scripts/_backfill-foo.ts", "--apply"]);
  // --apply must be LAST (a positional before it can't swallow it) and present (the whole fix).
  assert.equal(argv[argv.length - 1], "--apply");
  // `--` precedes the untrusted path so tsx never parses it as a flag.
  assert.equal(argv[1], "--");
  assert.ok(argv.indexOf("--") < argv.indexOf("scripts/_backfill-foo.ts"));
});

test("the child env sets APPLY=1 on top of the base env (belt to the --apply flag's braces)", () => {
  const env = buildBackfillEnv({ NODE_ENV: "test", PATH: "/usr/bin", FOO: "bar" });
  assert.equal(env.APPLY, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.FOO, "bar");
});

test("buildBackfillEnv does not mutate the input env", () => {
  const base: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin" };
  buildBackfillEnv(base);
  assert.equal(base.APPLY, undefined);
});

test("a DRY-RUN banner on stdout is detected (case-insensitive) so a no-op can't be marked ran", () => {
  assert.equal(isDryRunStdout("foo_backfill — DRY-RUN\n  would write 3 rows"), true);
  assert.equal(isDryRunStdout("ran in dry-run mode, nothing written"), true);
  // A real APPLY run never prints the banner → treated as a genuine success.
  assert.equal(isDryRunStdout("foo_backfill — APPLY\n  written 3 rows"), false);
  assert.equal(isDryRunStdout(""), false);
});

test("a test-file path (now rejected by the detector) fails executor capability validation too", () => {
  assert.equal(
    isValidScriptPathForExec("scripts/_backfill-foo.test.ts"),
    false,
    "a test file is never a runnable backfill",
  );
  assert.equal(
    isValidScriptPathForExec("scripts/_backfill-foo.spec.ts"),
    false,
  );
  // A genuine backfill still clears the gate.
  assert.equal(isValidScriptPathForExec("scripts/_backfill-foo.ts"), true);
  // Pre-existing rails still hold.
  assert.equal(isValidScriptPathForExec("-rf"), false);
  assert.equal(isValidScriptPathForExec("scripts/../etc/passwd"), false);
  assert.equal(isValidScriptPathForExec("/abs/scripts/_backfill-foo.ts"), false);
});
