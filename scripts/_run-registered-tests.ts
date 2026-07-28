/**
 * a-test-that-no-runner-executes-is-not-a-test-register-orphans-and-guard-new-ones Phase 3 —
 * runs the WHOLE registered `*.test.ts` suite in one shot, so the tests can be executed as a
 * whole rather than one `test:<name>` at a time.
 *
 * Reads every `test:*` script from package.json, extracts the `<path>` from `tsx --test <path>`
 * (the shared convention across the 100+ registered runners), and spawns a single
 * `tsx --test <path1> <path2> …` process — node:test aggregates the results across files.
 * Excludes `test:all` itself to avoid self-recursion.
 *
 * Wired: `npm run test:all` → this script.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = join(__dirname, "..");

function extractTestPathFromValue(value: string): string | null {
  const m = value.trim().match(/^tsx\s+--test\s+(\S+)/);
  return m ? m[1] : null;
}

function main(): void {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const paths: string[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (!name.startsWith("test:")) continue;
    if (name === "test:all") continue;
    const p = extractTestPathFromValue(value);
    if (p) paths.push(p);
  }
  if (paths.length === 0) {
    console.error("test:all — no registered test:* scripts found in package.json");
    process.exit(1);
  }
  console.log(`test:all — running ${paths.length} registered test file(s) via tsx --test`);
  const result = spawnSync("npx", ["tsx", "--test", ...paths], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  if (result.error) {
    console.error(`test:all — failed to spawn tsx: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main();
}
