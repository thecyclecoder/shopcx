/**
 * spec-phase-check-grep-is-smart-case Phase 1 — regression test.
 *
 * Pins the shared `shouldGrepCaseInsensitively` predicate + its wiring into both grep lanes:
 *   1. The predicate returns `true` for an all-lowercase pattern and `false` for a pattern with
 *      any uppercase ASCII letter (ripgrep's `--smart-case` semantic).
 *   2. `buildGrepArgv` (deterministic runner lane) prepends `-i` for the lowercase pattern and
 *      omits it for the uppercase pattern — the flag is added in userland, not delegated to
 *      ripgrep's `-S`, so the merge-gate `git grep` lane cannot drift.
 *   3. The exact historical case that motivated this spec: the pattern
 *      `cannot filter by log level` matches the line `CANNOT filter by log level` when the
 *      predicate's `-i` flag is honored.
 *
 *   npx tsx --test src/lib/spec-check-runner.smart-case.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldGrepCaseInsensitively } from "./spec-phase-checks-table";
import { buildGrepArgv } from "./spec-check-runner";

test("shouldGrepCaseInsensitively — true for an all-lowercase prose pattern", () => {
  assert.equal(shouldGrepCaseInsensitively("cannot filter by log level"), true);
  assert.equal(shouldGrepCaseInsensitively("hello world"), true);
  assert.equal(shouldGrepCaseInsensitively(""), true);
  // Digits and punctuation don't flip the switch — only uppercase ASCII letters do.
  assert.equal(shouldGrepCaseInsensitively("route-123 /path/to/thing"), true);
});

test("shouldGrepCaseInsensitively — false when the pattern carries ANY uppercase letter", () => {
  // Load-bearing identifier casing: SCREAMING_SNAKE, PascalCase, camelCase all stay exact.
  assert.equal(shouldGrepCaseInsensitively("VERCEL_LOG_DRAIN"), false);
  assert.equal(shouldGrepCaseInsensitively("ErrorSource"), false);
  assert.equal(shouldGrepCaseInsensitively("onRequestError"), false);
  // A single uppercase in an otherwise-lowercase phrase still counts as author-load-bearing.
  assert.equal(shouldGrepCaseInsensitively("A pattern with one upper"), false);
});

test("buildGrepArgv — prepends -i when the pattern is all lowercase (smart-case ON)", () => {
  const argv = buildGrepArgv({
    pattern: "cannot filter by log level",
    path: "docs/brain/integrations",
    expect: "present",
  });
  assert.deepEqual(argv, ["-i", "-e", "cannot filter by log level", "--", "docs/brain/integrations"]);
});

test("buildGrepArgv — omits -i when the pattern carries uppercase (smart-case OFF)", () => {
  const argv = buildGrepArgv({
    pattern: "VERCEL_LOG_DRAIN",
    path: "src/lib",
    expect: "present",
  });
  assert.deepEqual(argv, ["-e", "VERCEL_LOG_DRAIN", "--", "src/lib"]);
});

test("buildGrepArgv — smart-case preserves the existing argv hardening (pattern under -e, path after --)", () => {
  // A `-`-leading pattern (also all-lowercase) still lands under `-e` so rg treats it as data,
  // and the path still sits after the `--` separator — the smart-case `-i` is a prepend, not a
  // rewrite of the hardening layout.
  const argv = buildGrepArgv({ pattern: "-not-a-flag", path: "src/lib", expect: "present" });
  assert.deepEqual(argv, ["-i", "-e", "-not-a-flag", "--", "src/lib"]);
  // Default path (`.`) is preserved through the smart-case path.
  const noPath = buildGrepArgv({ pattern: "lowercase phrase", expect: "present" });
  assert.deepEqual(noPath, ["-i", "-e", "lowercase phrase", "--", "."]);
});

test("smart-case semantic — the historical incident: 'cannot filter by log level' matches 'CANNOT filter by log level'", () => {
  // Ground-truth: the pattern that parked `replace-log-drain-with-in-process-onrequesterror`
  // for three days is all-lowercase, so smart-case turns on, and a case-insensitive regex over
  // the source line (which capitalized the first word for emphasis) matches. No -i → no match →
  // three redrives → redrive cap → shipped code stranded. -i → match → check passes.
  const pattern = "cannot filter by log level";
  const sourceLine = "CANNOT filter by log level";
  assert.equal(shouldGrepCaseInsensitively(pattern), true);
  // Emulate the effect of `-i`: with the flag ON, the pattern matches the differently-cased line.
  assert.match(sourceLine, new RegExp(pattern, "i"));
  // Without the flag, it does NOT — the exact failure mode the rail closes.
  assert.doesNotMatch(sourceLine, new RegExp(pattern));
});
