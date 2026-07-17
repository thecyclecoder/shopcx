/**
 * Predeploy guard: the box's tsx entrypoints must TYPECHECK too, not just parse.
 *
 * Sibling to `scripts/_check-box-parses.ts` (which catches SYNTAX errors under the
 * box's real parser — esbuild). This one catches TYPE errors (wrong-arity calls,
 * wrong property names, wrong namespaces) using the TypeScript compiler over a
 * scoped `tsconfig.box.json` that includes exactly the box entrypoint list.
 *
 * THE INCIDENT this exists to prevent: June's (CS Director) prompt-review runner
 * in `scripts/builder-worker.ts` called `applyDecision()` with 6 positional args,
 * silently dropping the 5th (`inputs`) — so `inputs.proposal` was undefined at
 * runtime → a NOT-NULL insert violation that jammed the rule-review queue for a
 * week (~127 failed retries; fixed in PR #1971). `check:box-parses` esbuild-PARSES
 * the box code but esbuild STRIPS types — it cannot catch a wrong-arity call. The
 * main `npx tsc --noEmit` gate skips `scripts/` entirely (tsconfig `exclude`), so
 * that class of bug had no gate at all. This runner closes the gap by running the
 * TypeScript compiler over `tsconfig.box.json`, which does NOT exclude scripts/.
 *
 * WHAT IT DOES: spawns `tsc -p tsconfig.box.json --noEmit --pretty false` and
 * relays the compiler's file:line-annotated diagnostics on failure. Output is
 * discarded on success — parse/typecheck-only, the box code is NEVER executed.
 *
 * Wired into `predeploy` (`npm run check:box-types`) immediately after
 * `check:box-parses` so this bug class fails CI red, not silently at box runtime.
 *
 * Read-only by construction: reads source, typechecks, discards. Never mutates
 * state, never runs the box code.
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..");
const TSCONFIG = resolve(REPO_ROOT, "tsconfig.box.json");

function fail(msg: string): never {
  console.error(`\n❌ check-box-types — ${msg}\n`);
  process.exit(1);
}

function main() {
  if (!existsSync(TSCONFIG)) {
    fail(`tsconfig.box.json not found at ${TSCONFIG} — this check requires the scoped tsconfig.`);
  }

  // Prefer local `tsc` binary; fall back to `npx tsc`. `--pretty false` gives
  // stable, greppable one-line-per-diagnostic output.
  const tscBin = resolve(REPO_ROOT, "node_modules/.bin/tsc");
  const cmd = existsSync(tscBin) ? tscBin : "npx";
  const args = existsSync(tscBin)
    ? ["-p", TSCONFIG, "--noEmit", "--pretty", "false"]
    : ["tsc", "-p", TSCONFIG, "--noEmit", "--pretty", "false"];

  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.error) {
    fail(`failed to launch tsc — ${res.error.message}`);
  }

  const stdout = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();
  const combined = [stdout, stderr].filter(Boolean).join("\n");

  if (res.status !== 0) {
    console.error(`\n❌ check-box-types — scoped tsc over tsconfig.box.json failed:\n`);
    if (combined) console.error(combined);
    console.error(
      `\nThese files are the box's tsx entrypoints (systemd + agent-spawned tsx).\n` +
      `The main \`tsc --noEmit\` gate excludes scripts/ so type errors here have\n` +
      `NO gate — the exact hole that let June's dropped-\`inputs\` bug ship (PR #1971).\n` +
      `Fix each error above (real property/arg/namespace mismatch — do NOT blanket\n` +
      `\`any\`-cast to silence) before merging.\n`,
    );
    process.exit(1);
  }

  console.log(`✓ check-box-types — box tsx entrypoints typecheck clean under tsconfig.box.json`);
  if (combined) console.log(combined);
}

main();
