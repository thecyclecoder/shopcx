/**
 * pulse-recap-import-safety — regression pin for the 6 pre-merge spec-test
 * checks against planner-authoring-survives-large-multi-spec-output.
 *
 * Every failing check ("[check fbccb6a5f6d4200e]", "[check 8be2363537ceb4cf]",
 * "[check 84584ab0eeeb965a]", "[check f651c157dabdf31a]",
 * "[check f72e70228748d331]", "[check d501539fe2ba5bff]") reported the same
 * evidence shape: the branch worker startup probe / branch test suite exited 1
 * with `[pulse-recap] no transcripts directory at …` before any planner code
 * could run. Root cause: scripts/pulse-recap.ts line ~419 calls `main()` at
 * MODULE IMPORT time, so any module that transitively imports pulse-recap
 * (scripts/planner-transcript-recover.ts imports `findTranscriptAcrossProjects`
 * from it, and scripts/builder-worker.ts imports the recover helper) forces
 * pulse-recap's CLI main() to run on ordinary import. In a fresh worker /
 * spec-test environment where `~/.claude/projects` doesn't exist, main() calls
 * `process.exit(1)` and takes down the whole importing process.
 *
 * Fix: gate the `main()` invocation on `require.main === module` — the
 * idiomatic CLI-only guard already used across scripts/ (see e.g.
 * scripts/_check-table-refs-have-migrations.ts:243 · scripts/_audit-pm-md-reads.ts:412).
 * pulse-recap keeps its CLI behavior when invoked directly (`npx tsx
 * scripts/pulse-recap.ts`) but becomes a pure module load when imported.
 *
 * This test spawns `tsx` in a fresh child process with `HOME` pointed at an
 * ephemeral empty directory (guarantees `~/.claude/projects` does not exist —
 * the exact shape the spec-test hit) and asserts that requiring the recover
 * helper exits 0. BEFORE the fix, this exits 1 with the pulse-recap error.
 *
 *   npx tsx --test scripts/pulse-recap-import-safety.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

test("requiring scripts/planner-transcript-recover exits 0 even when ~/.claude/projects does not exist", () => {
  const repoRoot = resolve(__dirname, "..");
  // Ephemeral HOME with no ~/.claude tree — guarantees `~/.claude/projects`
  // resolves to a non-existent path, the exact shape the spec-test hit.
  const stubHome = mkdtempSync(join(tmpdir(), "pulse-import-safety-"));
  const r = spawnSync(
    "npx",
    [
      "tsx",
      "-e",
      'require("./scripts/planner-transcript-recover"); console.log("import-ok");',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: stubHome, CLAUDE_CODE_SESSION_ID: "" },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(
    r.status,
    0,
    `importing the transcript-recover helper must not exit non-zero (status=${r.status}, stderr=${(r.stderr || "").slice(-800)})`,
  );
  assert.match(r.stdout, /import-ok/);
});

test("requiring scripts/pulse-recap directly also exits 0 (CLI main() gated behind require.main === module)", () => {
  const repoRoot = resolve(__dirname, "..");
  const stubHome = mkdtempSync(join(tmpdir(), "pulse-import-safety-cli-gate-"));
  const r = spawnSync(
    "npx",
    ["tsx", "-e", 'require("./scripts/pulse-recap"); console.log("import-ok");'],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: stubHome, CLAUDE_CODE_SESSION_ID: "" },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(
    r.status,
    0,
    `importing pulse-recap must not exit non-zero (status=${r.status}, stderr=${(r.stderr || "").slice(-800)})`,
  );
  assert.match(r.stdout, /import-ok/);
});
