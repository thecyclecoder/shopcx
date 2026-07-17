/**
 * Predeploy guard: the parse-gate list and the type-gate list of BOX ENTRYPOINTS
 * must stay set-equal.
 *
 * TWO lists now name the box's tsx entrypoints:
 *   • parse-gate: `BOX_ENTRYPOINTS` in `scripts/_check-box-parses.ts` (esbuild-parse)
 *   • type-gate: the `include` array in `tsconfig.box.json` (scoped `tsc --noEmit`)
 *
 * If someone adds a NEW `tsx scripts/<x>.ts` the box runs (a new systemd unit /
 * a script the worker/agents spawn) and updates only ONE list, the OTHER silently
 * under-covers — re-opening the exact "no gate" hole the type-gate spec closed
 * (the June `applyDecision` wrong-arity that jammed the rule-review queue for a
 * week, fixed in PR #1971). This runner reads both lists and fails CI red naming
 * any list-only entry, so drift is impossible without a red build.
 *
 * WHAT IT DOES: parses the `BOX_ENTRYPOINTS` array literal out of
 * `scripts/_check-box-parses.ts` and the `include` array out of
 * `tsconfig.box.json`, normalizes both to sorted strings, and asserts they are
 * set-equal. ANY diff (parse-only, types-only, or both mismatched) fails red
 * with a clear "add to <other list>" hint. Read-only by construction.
 *
 * Wired into `predeploy` (`npm run check:box-entrypoints-in-sync`) so drift
 * cannot merge silently.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..");
const PARSE_GATE_PATH = resolve(REPO_ROOT, "scripts/_check-box-parses.ts");
// String-referenced by path in the CI verification check (Phase 2 grep gate).
const TSCONFIG_PATH = resolve(REPO_ROOT, "tsconfig.box.json");

function fail(msg: string): never {
  console.error(`\n❌ check-box-entrypoints-in-sync — ${msg}\n`);
  process.exit(1);
}

/**
 * Extract the `BOX_ENTRYPOINTS` string-array literal from the parse-gate source.
 * Regex-parses `const BOX_ENTRYPOINTS = [ ... ];` — every element is a quoted
 * `scripts/*.ts` path (trailing comments allowed). Trailing commas + inline `//`
 * comments after each entry are tolerated. Fails loudly on any shape it can't
 * confidently read (safer than silently returning a partial list, which would
 * make the sync guard falsely GREEN).
 */
function readBoxEntrypointsFromParseGate(): string[] {
  if (!existsSync(PARSE_GATE_PATH)) {
    fail(`parse-gate not found at ${PARSE_GATE_PATH} — this check requires scripts/_check-box-parses.ts.`);
  }
  const src = readFileSync(PARSE_GATE_PATH, "utf8");
  // Match `const BOX_ENTRYPOINTS = [ ... ];` — the array body is captured
  // (non-greedy, spans multiple lines).
  const m = src.match(/const\s+BOX_ENTRYPOINTS\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]\s*;/);
  if (!m) {
    fail(`could not locate \`const BOX_ENTRYPOINTS = [ ... ];\` in ${PARSE_GATE_PATH} — did the parse-gate get restructured?`);
  }
  const body = m[1];
  // Extract every quoted string literal in the array body. `"scripts/..."` or
  // `'scripts/...'` — both accepted (parse-gate uses double quotes today).
  const items = [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  if (items.length === 0) {
    fail(`parsed \`BOX_ENTRYPOINTS\` array from ${PARSE_GATE_PATH} but found 0 entries — refusing to succeed against an empty list.`);
  }
  return items;
}

/**
 * Extract the `include` array from tsconfig.box.json. Uses plain JSON.parse —
 * the file must be valid JSON (a `"//"` comment key is fine, TypeScript ignores
 * unknown keys and JSON.parse reads it as a normal property). Fails loudly if
 * `include` is missing / non-array / empty.
 */
function readBoxEntrypointsFromTsconfig(): string[] {
  if (!existsSync(TSCONFIG_PATH)) {
    fail(`tsconfig.box.json not found at ${TSCONFIG_PATH} — this check requires the scoped tsconfig from Phase 1.`);
  }
  const src = readFileSync(TSCONFIG_PATH, "utf8");
  let parsed: { include?: unknown };
  try {
    parsed = JSON.parse(src) as { include?: unknown };
  } catch (e) {
    fail(`tsconfig.box.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const inc = parsed.include;
  if (!Array.isArray(inc) || inc.length === 0) {
    fail(`tsconfig.box.json \`include\` must be a non-empty string array (got ${JSON.stringify(inc)}).`);
  }
  const items = inc.map((x, i) => {
    if (typeof x !== "string") fail(`tsconfig.box.json \`include\`[${i}] is not a string (got ${JSON.stringify(x)}).`);
    return x;
  });
  return items;
}

function main() {
  const parseList = readBoxEntrypointsFromParseGate();
  const typeList = readBoxEntrypointsFromTsconfig();

  const parseSet = new Set(parseList);
  const typeSet = new Set(typeList);

  const onlyInParse = [...parseSet].filter((p) => !typeSet.has(p)).sort();
  const onlyInType = [...typeSet].filter((p) => !parseSet.has(p)).sort();

  if (onlyInParse.length === 0 && onlyInType.length === 0) {
    // Same-size AND same-membership: set-equal.
    console.log(
      `✓ check-box-entrypoints-in-sync — parse-gate (scripts/_check-box-parses.ts BOX_ENTRYPOINTS) ` +
      `and type-gate (tsconfig.box.json \`include\`) are set-equal (${parseSet.size} entrypoint(s)).`,
    );
    return;
  }

  console.error(`\n❌ check-box-entrypoints-in-sync — box entrypoint lists have DRIFTED.\n`);
  if (onlyInParse.length) {
    console.error(`  Only in parse-gate (\`BOX_ENTRYPOINTS\` in scripts/_check-box-parses.ts) — MISSING from tsconfig.box.json \`include\`:`);
    for (const p of onlyInParse) console.error(`    • ${p}`);
    console.error(`  → Add each above path to tsconfig.box.json's \`include\` array so it's type-gated too.\n`);
  }
  if (onlyInType.length) {
    console.error(`  Only in type-gate (tsconfig.box.json \`include\`) — MISSING from \`BOX_ENTRYPOINTS\` in scripts/_check-box-parses.ts:`);
    for (const p of onlyInType) console.error(`    • ${p}`);
    console.error(`  → Add each above path to \`BOX_ENTRYPOINTS\` in scripts/_check-box-parses.ts so it's parse-gated too.\n`);
  }
  console.error(
    `A box tsx entrypoint parse-gated but not type-gated (or vice versa) re-opens the exact "no gate" hole\n` +
    `Phase 1 closed (June's dropped-\`inputs\` PR #1971). Keep the two lists byte-identical.\n`,
  );
  process.exit(1);
}

main();
