/**
 * Unit tests for machine-declared-verification Phase 1 — `validateExecutableCheck` + the read-only-SQL
 * guard `isPlainReadonlySql`. One accept + one reject per exec_kind. Pure functions — no DB.
 *
 *   npx tsx --test src/lib/spec-phase-checks-table.test.ts
 *
 * The unit_test path pins the durable rule: a script name absent from package.json rejects at authoring,
 * not at runtime — the exact rail that closes the cs-director `npm test` class the spec cites in § Why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateExecutableCheck,
  isPlainReadonlySql,
  detectBuilderChosenNameInGrep,
  type SpecPhaseCheckExecKind,
} from "./spec-phase-checks-table";

test("validateExecutableCheck rejects a missing exec_kind", () => {
  const r = validateExecutableCheck({ exec_kind: null });
  assert.equal(r.valid, false);
  assert.match((r as { reason: string }).reason, /exec_kind is required/);
});

test("tsc / build accept null params + reject any params", () => {
  for (const kind of ["tsc", "build"] as SpecPhaseCheckExecKind[]) {
    assert.equal(validateExecutableCheck({ exec_kind: kind }).valid, true);
    assert.equal(validateExecutableCheck({ exec_kind: kind, params: null }).valid, true);
    const r = validateExecutableCheck({ exec_kind: kind, params: { anything: 1 } });
    assert.equal(r.valid, false, `${kind} should reject params`);
    assert.match((r as { reason: string }).reason, /takes no params/);
  }
});

test("needs_human accepts null params + never carries params", () => {
  assert.equal(validateExecutableCheck({ exec_kind: "needs_human" }).valid, true);
  const r = validateExecutableCheck({ exec_kind: "needs_human", params: { x: 1 } });
  assert.equal(r.valid, false);
  assert.match((r as { reason: string }).reason, /never auto-run/);
});

test("grep requires { pattern, expect } with expect in {present, absent}", () => {
  assert.equal(
    validateExecutableCheck({
      exec_kind: "grep",
      params: { pattern: "runSpecChecks", path: "src/lib", expect: "present" },
    }).valid,
    true,
  );
  const noPattern = validateExecutableCheck({ exec_kind: "grep", params: { expect: "present" } });
  assert.equal(noPattern.valid, false);
  assert.match((noPattern as { reason: string }).reason, /pattern/);
  const badExpect = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "x", expect: "maybe" },
  });
  assert.equal(badExpect.valid, false);
  assert.match((badExpect as { reason: string }).reason, /'present' or 'absent'/);
});

test("grep.path rejects option-looking, absolute, traversing, NUL, and empty values", () => {
  // The exact vulnerability the harden-deterministic-grep-check-paths spec closes: a spec-authored
  // grep.path is an untrusted argument that could otherwise reach `rg` as `--pre=tsx` /
  // `--search-zip` / an absolute path escape. Belt-and-suspenders — the runner also places `--`
  // before the path in argv (see `buildGrepArgv` in spec-check-runner), but this predicate must
  // reject the payload BEFORE spawn.
  const optionish = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "PRESENT", path: "--pre=tsx", expect: "present" },
  });
  assert.equal(optionish.valid, false, "grep.path='--pre=tsx' must reject (rg option/preprocessor)");
  assert.match((optionish as { reason: string }).reason, /must not start with '-'/);

  const dashOnly = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "x", path: "-abc", expect: "present" },
  });
  assert.equal(dashOnly.valid, false);

  const absolute = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "x", path: "/etc/passwd", expect: "present" },
  });
  assert.equal(absolute.valid, false);
  assert.match((absolute as { reason: string }).reason, /repo-relative, not absolute/);

  const traversal = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "x", path: "../../etc/passwd", expect: "present" },
  });
  assert.equal(traversal.valid, false);
  assert.match((traversal as { reason: string }).reason, /outside the repo/);

  const nul = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "x", path: "src/lib\0/foo", expect: "present" },
  });
  assert.equal(nul.valid, false);
  assert.match((nul as { reason: string }).reason, /NUL/);

  const empty = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "x", path: "   ", expect: "present" },
  });
  assert.equal(empty.valid, false);

  // Sanity: normal repo-relative paths + an inner `..` that stays under root still accept.
  for (const good of ["src/lib", "src/lib/spec-check-runner.ts", "src/lib/./nested", "src/foo/../lib"]) {
    const r = validateExecutableCheck({
      exec_kind: "grep",
      params: { pattern: "x", path: good, expect: "present" },
    });
    assert.equal(r.valid, true, `grep.path='${good}' must accept`);
  }
});

test("ci_status takes no params", () => {
  assert.equal(validateExecutableCheck({ exec_kind: "ci_status" }).valid, true);
  const r = validateExecutableCheck({ exec_kind: "ci_status", params: { branch: "main" } });
  assert.equal(r.valid, false);
  assert.match((r as { reason: string }).reason, /takes no params/);
});

test("http_get requires { url, expect_status } with a valid URL + HTTP status", () => {
  assert.equal(
    validateExecutableCheck({
      exec_kind: "http_get",
      params: { url: "https://shopcx.ai/roadmap", expect_status: 200 },
    }).valid,
    true,
  );
  const badUrl = validateExecutableCheck({
    exec_kind: "http_get",
    params: { url: "/roadmap", expect_status: 200 },
  });
  assert.equal(badUrl.valid, false);
  assert.match((badUrl as { reason: string }).reason, /full http\(s\)/);
  const badStatus = validateExecutableCheck({
    exec_kind: "http_get",
    params: { url: "https://x.example", expect_status: 99 },
  });
  assert.equal(badStatus.valid, false);
});

test("db_probe_readonly names a registered probe_id + binds workspace_id + rejects sensitive arg names", () => {
  // Happy path: a registered probe with all required args and a scalar expect.
  assert.equal(
    validateExecutableCheck({
      exec_kind: "db_probe_readonly",
      params: {
        probe_id: "spec_exists_by_slug",
        args: { workspace_id: "ws-1", slug: "spec-x" },
        expect: true,
      },
    }).valid,
    true,
  );
  // Reject: expect is required (may be null).
  const noExpect = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: { probe_id: "spec_exists_by_slug", args: { workspace_id: "ws-1", slug: "spec-x" } },
  });
  assert.equal(noExpect.valid, false);
  assert.match((noExpect as { reason: string }).reason, /expect is required/);
  // Reject: unknown probe_id — the constrained-registry rail. No free-form SQL is executable.
  const unknown = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: { probe_id: "delete_specs", expect: null },
  });
  assert.equal(unknown.valid, false);
  assert.match((unknown as { reason: string }).reason, /not a registered probe/);
  // Reject: missing required arg for the registered probe (workspace_id).
  const missing = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: { probe_id: "spec_exists_by_slug", args: { slug: "spec-x" }, expect: true },
  });
  assert.equal(missing.valid, false);
  assert.match((missing as { reason: string }).reason, /missing required arg/);
  // Reject: arg name looks like a secret column — the denylist covers `*_encrypted`, `secret_`, `api_key`, `private_key`, `token`.
  for (const bad of ["api_key", "user_token", "session_token", "credentials_encrypted", "secret_id", "private_key"]) {
    const r = validateExecutableCheck({
      exec_kind: "db_probe_readonly",
      params: {
        probe_id: "spec_exists_by_slug",
        args: { workspace_id: "ws-1", slug: "spec-x", [bad]: "x" },
        expect: true,
      },
    });
    assert.equal(r.valid, false, `arg named '${bad}' must reject`);
    assert.match((r as { reason: string }).reason, /sensitive column/);
  }
  // Reject: object expect — probes return a scalar.
  const complexExpect = validateExecutableCheck({
    exec_kind: "db_probe_readonly",
    params: {
      probe_id: "spec_exists_by_slug",
      args: { workspace_id: "ws-1", slug: "spec-x" },
      expect: { rows: 1 },
    },
  });
  assert.equal(complexExpect.valid, false);
  assert.match((complexExpect as { reason: string }).reason, /null \| number \| boolean/);
});

test("unit_test rejects a script that is not in package.json (closes the cs-director npm test class)", () => {
  const packageScripts = new Set(["test:build-lifecycle", "test:cart-gifts"]);
  const ok = validateExecutableCheck(
    { exec_kind: "unit_test", params: { script: "test:build-lifecycle" } },
    { packageScripts },
  );
  assert.equal(ok.valid, true);
  const missing = validateExecutableCheck(
    { exec_kind: "unit_test", params: { script: "test" } },
    { packageScripts },
  );
  assert.equal(missing.valid, false);
  assert.match((missing as { reason: string }).reason, /not a package\.json script/);
  // No packageScripts context → shape is validated but the existence check is skipped.
  assert.equal(
    validateExecutableCheck({ exec_kind: "unit_test", params: { script: "anything" } }).valid,
    true,
  );
});

// ── verification-check-must-not-demand-a-name-the-builder-has-to-guess Phase 1 ──────────────────
//
// The bar: an author cannot pin an exact literal for a name the BUILDER invents. Two specs each
// burned five builds — `test:graduate-crowned` (npm script name; the correct build registered
// `test:media-buyer-graduate-scaler`) and `quant-desk` (a lifecycle page authored as `Quant-desk`
// — a case-sensitive miss). No LLM pass guesses one specific kebab-case string, so the check must
// fail at authoring, not at build time.

test("detectBuilderChosenNameInGrep flags test:<slug> npm-script literal + suggests a regex", () => {
  const g = detectBuilderChosenNameInGrep("test:graduate-crowned");
  assert.ok(g, "test:graduate-crowned must flag as builder-chosen");
  assert.match(g!.reason, /npm script name/i);
  assert.equal(g!.suggested, "test:.*crowned");
});

test("detectBuilderChosenNameInGrep flags kebab-case names + suggests case-insensitive regex", () => {
  const g = detectBuilderChosenNameInGrep("quant-desk");
  assert.ok(g, "quant-desk must flag (the case-sensitivity trap)");
  assert.match(g!.reason, /kebab-case/i);
  assert.match(g!.suggested, /\(\?i\)/, "suggested pattern must be case-insensitive");
});

test("detectBuilderChosenNameInGrep flags *.test.ts filename literals", () => {
  const g = detectBuilderChosenNameInGrep("scaler.test.ts");
  assert.ok(g, "scaler.test.ts must flag as builder-chosen filename");
  assert.match(g!.reason, /test filename/i);
  assert.match(g!.suggested, /\\\.test\\\./);
});

test("detectBuilderChosenNameInGrep flags camelCase symbols the spec does NOT pin", () => {
  const g = detectBuilderChosenNameInGrep("handleRedemption");
  assert.ok(g, "camelCase symbol not in spec text must flag");
  assert.match(g!.reason, /camelCase symbol/i);
});

test("detectBuilderChosenNameInGrep ALLOWS a literal the spec body pins (case-insensitive)", () => {
  const spec = "Phase 1 wires `consumeRedemption` at the redemption chokepoint (see specs-table).";
  assert.equal(
    detectBuilderChosenNameInGrep("consumeRedemption", spec),
    null,
    "a spec-pinned symbol must NOT flag — the author fixed the name",
  );
  // Case-insensitive match: spec says `Quant-Desk`, check greps `quant-desk` — still spec-pinned.
  const capd = "The Quant-Desk lifecycle wires the review reader.";
  assert.equal(detectBuilderChosenNameInGrep("quant-desk", capd), null);
});

test("detectBuilderChosenNameInGrep ALLOWS a pattern with regex metacharacters (already a pattern)", () => {
  for (const p of ["test:.*graduate", "quant.desk", "foo|bar", "run\\w+Checks", "consume\\(", "^Phase 1"]) {
    assert.equal(detectBuilderChosenNameInGrep(p), null, `metachar pattern "${p}" must NOT flag`);
  }
});

test("detectBuilderChosenNameInGrep ALLOWS bare single-word identifiers with no camelCase transition", () => {
  for (const p of ["Phase", "runner", "hero", "SELECT", "test", "graduate"]) {
    assert.equal(detectBuilderChosenNameInGrep(p), null, `bare word "${p}" must NOT flag`);
  }
});

test("validateExecutableCheck rejects a builder-chosen grep pattern when specText is provided", () => {
  // The exact shape that stranded 5 builds: a `test:*` literal in package.json with no spec-body pin.
  const specText = "Phase 1 registers a test that graduates crowned winners. Verify with tsc + grep.";
  const rejected = validateExecutableCheck(
    { exec_kind: "grep", params: { pattern: "test:graduate-crowned", path: "package.json", expect: "present" } },
    { specText },
  );
  assert.equal(rejected.valid, false, "builder-chosen npm script name must reject at author time");
  assert.match((rejected as { reason: string }).reason, /Try grep\.pattern: test:\.\*crowned/);
});

test("validateExecutableCheck accepts a builder-chosen literal that the spec body pins", () => {
  const specText = "Phase 1 registers `test:graduate-crowned` as the graduation smoke test.";
  const ok = validateExecutableCheck(
    { exec_kind: "grep", params: { pattern: "test:graduate-crowned", path: "package.json", expect: "present" } },
    { specText },
  );
  assert.equal(ok.valid, true, "spec-pinned literal must pass — the author fixed the name");
});

test("validateExecutableCheck without specText does NOT retroactively reject old grep literals", () => {
  // The runner path passes no specText — an already-authored bare-literal check must not
  // suddenly fail on this guard at runtime. Defense-in-depth lives at author time.
  const ok = validateExecutableCheck({
    exec_kind: "grep",
    params: { pattern: "test:graduate-crowned", path: "package.json", expect: "present" },
  });
  assert.equal(ok.valid, true, "no specText → no builder-chosen guard (runner-safe default)");
});

// ── grep-check-guess-guard-closes-alternation-and-pin-gaps Phase 1 ──────────────────────────────
//
// The 2026-08-02 live-guard measurement — three guessed names joined by `|` sailed through the
// metachar bail while a single guess was flagged, stranding the subscription-mutation spec for
// over three days. These cases pin the fix so it cannot regress.

test("detectBuilderChosenNameInGrep REJECTS an alternation of guessed camelCase names (three-branch)", () => {
  // The exact incident pattern the guard let through on 2026-08-02.
  const g = detectBuilderChosenNameInGrep("verifyMutation|verifyContractState|assertLineState");
  assert.ok(g, "an alternation of three guessed camelCase names must reject");
  assert.match(g!.reason, /alternation of 3 names/i);
  // Suggested pattern is a case-insensitive alternation of the distinctive tokens.
  assert.match(g!.suggested, /verifyMutation/);
  assert.match(g!.suggested, /verifyContractState/);
  assert.match(g!.suggested, /assertLineState/);
  assert.match(g!.suggested, /\(\?i\)/);
});

test("detectBuilderChosenNameInGrep REJECTS an alternation of guessed npm-script names", () => {
  const g = detectBuilderChosenNameInGrep("test:graduate-crowned|test:media-buyer-winner");
  assert.ok(g, "an alternation of two guessed npm scripts must reject");
  assert.match(g!.reason, /alternation/i);
  assert.match(g!.suggested, /crowned/);
  assert.match(g!.suggested, /winner/);
});

test("detectBuilderChosenNameInGrep REJECTS an alternation of guessed kebab-case slugs", () => {
  const g = detectBuilderChosenNameInGrep("quant-desk|hero-desk");
  assert.ok(g, "an alternation of two guessed kebab-case names must reject");
  assert.match(g!.reason, /alternation/i);
  // Distinctive tokens (longest hyphen-split token) end up in the suggestion.
  assert.match(g!.suggested, /quant/i);
  assert.match(g!.suggested, /hero/i);
});

test("detectBuilderChosenNameInGrep still REJECTS a single guessed camelCase name (regression)", () => {
  // The single-name case must keep flagging; closing the alternation hole does not weaken the
  // one-guess rule the origin spec landed. `verifyContractState` alone stays rejected.
  const g = detectBuilderChosenNameInGrep("verifyContractState");
  assert.ok(g);
  assert.match(g!.reason, /camelCase symbol/i);
});

test("detectBuilderChosenNameInGrep ALLOWS an alternation that contains a spec-pinned branch", () => {
  // A real alternation with ONE genuine spec-pinned term stays legal — closing the hole must not
  // over-reject or authoring becomes blocked on legitimate patterns.
  const spec = "Phase 1 wires `consumeRedemption` at the redemption chokepoint (see specs-table).";
  assert.equal(
    detectBuilderChosenNameInGrep("consumeRedemption|verifyContractState", spec),
    null,
    "an alternation containing a spec-pinned branch must NOT reject",
  );
});

test("detectBuilderChosenNameInGrep ALLOWS an alternation with a genuine regex branch (character class)", () => {
  // A branch that carries its own metachars (character class, anchor, quantifier, group) reads as
  // a real pattern piece — the whole alternation stays allowed.
  for (const p of ["[a-z]|[A-Z]", "^Phase\\s+1|Phase 1", "handleRedemption|runSpec.+"]) {
    assert.equal(
      detectBuilderChosenNameInGrep(p),
      null,
      `alternation with a real-regex branch "${p}" must NOT flag`,
    );
  }
});

test("detectBuilderChosenNameInGrep ALLOWS an alternation of legitimate bare words (no builder-chosen shape)", () => {
  // The pre-existing invariant: `foo|bar` was allowed by the metachar bail. Now it is allowed by
  // the per-branch judge — neither `foo` nor `bar` is a builder-chosen shape (no npm colon, no
  // kebab hyphen, no camelCase transition, no `.test.` filename). The union stays allowed.
  assert.equal(detectBuilderChosenNameInGrep("foo|bar"), null);
  assert.equal(detectBuilderChosenNameInGrep("SELECT|INSERT|UPDATE"), null);
});

test("validateExecutableCheck rejects a builder-chosen alternation grep pattern at author time", () => {
  const specText = "Phase 1 verifies the mutation actually happened rather than trusting HTTP 200.";
  const rejected = validateExecutableCheck(
    {
      exec_kind: "grep",
      params: {
        pattern: "verifyMutation|verifyContractState|assertLineState",
        path: "src/lib",
        expect: "present",
      },
    },
    { specText },
  );
  assert.equal(
    rejected.valid,
    false,
    "an alternation of three guessed camelCase names must reject at author time",
  );
  assert.match((rejected as { reason: string }).reason, /alternation of 3 names/i);
});

test("isPlainReadonlySql accepts SELECT + WITH; rejects chained + mutating statements", () => {
  assert.equal(isPlainReadonlySql("SELECT id FROM public.specs"), true);
  assert.equal(isPlainReadonlySql("with a as (select 1) select * from a"), true);
  assert.equal(isPlainReadonlySql("select 1;"), true);
  assert.equal(isPlainReadonlySql("SELECT 1; DROP TABLE specs"), false);
  assert.equal(isPlainReadonlySql("UPDATE specs SET slug='x'"), false);
  assert.equal(isPlainReadonlySql("truncate specs"), false);
  assert.equal(isPlainReadonlySql(""), false);
});
