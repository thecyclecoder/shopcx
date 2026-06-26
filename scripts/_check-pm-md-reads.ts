/**
 * Static-analysis check: no NEW markdown-read site in the PM flow.
 *
 * The PM flow ("every code path that reads a spec to advance, render, or reconcile its state") is
 * supposed to consume `public.specs` + `public.spec_phases` directly via the typed reader
 * (`getSpec` / `listSpecs` in [[../src/lib/specs-table.ts]]) — never a `docs/brain/specs/*.md`
 * HTTP fetch, never `parseSpec` over a raw blob, never `phaseStatesFromRaw` over a markdown
 * string. That is the "Database is the spec" invariant from CLAUDE.md, enforced not just stated.
 *
 * This script walks the PM-flow file set, scans for the eight md-read patterns Phase 1 catalogued,
 * and exits non-zero on any finding outside the INTENTIONAL_MATERIALIZATION allow-list (the
 * surviving consumers `docs/brain/recipes/pm-flow-data-sources.md` lists). Mirrors the
 * `_check-worker-lanes.ts` shape that ships under the Vale revival spec.
 *
 * PENDING_PHASE_2_RETIREMENT — a transitional allow-list of call sites Phase 2 will delete or
 * rewrite. Each entry must SHRINK with that PR; once Phase 2 lands, the set is empty and the
 * regression door is fully closed. Adding a new entry here is a code-smell: the new caller should
 * go straight to the DB readers instead.
 *
 * Wired into `npm run check:pm-md-reads` + chained into `predeploy` so a regression breaks CI red,
 * not silently. Read-only; never mutates state.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, join, sep } from "path";

const REPO_ROOT = resolve(__dirname, "..");

/**
 * PM-flow file globs. Phase 1's audit walks the same set; the check + the recipe agree on scope so
 * a finding here is provably a PM-flow concern, not a tangential md-read.
 */
const PM_LIB_PREFIXES = [
  "spec-",
  "specs-",
  "spec_",
  "pm-",
  "brain-roadmap",
  "agent-jobs",
  "author-",
  "build-spec-materializer",
];
const PM_API_ROOTS = [
  "src/app/api/roadmap",
  "src/app/api/specs",
];
const PM_BOX_FILES = [
  "scripts/builder-worker.ts",
];
const LIB_DIR = "src/lib";

/**
 * Patterns Phase 1 catalogued. Each one is a fingerprint of a "consume markdown" call (read from
 * disk / HTTP, parse the blob, or round-trip via the serializer). The PM flow MUST NOT do any of
 * these — the typed `SpecRow` + `SpecPhaseRow[]` carry the same data.
 */
type Pattern = { name: string; regex: RegExp };
const PATTERNS: Pattern[] = [
  { name: "literal-docs-brain-specs", regex: /"docs\/brain\/specs\//g },
  { name: "fetchSpecRawFromMain", regex: /\bfetchSpecRawFromMain\s*\(/g },
  { name: "parseSpec-call", regex: /\bparseSpec\s*\(/g },
  { name: "phaseStatesFromRaw", regex: /\bphaseStatesFromRaw\s*\(/g },
  { name: "mergePhaseStates", regex: /\bmergePhaseStates\s*\(/g },
  { name: "serializeSpecRowToMarkdown", regex: /\bserializeSpecRowToMarkdown\s*\(/g },
  { name: "readFileSync-dot-md", regex: /\breadFileSync\s*\([^)]*\.md["']/g },
  { name: "readFile-dot-md", regex: /\breadFile\s*\([^)]*\.md["']/g },
  { name: "raw-github-spec-fetch", regex: /raw\.githubusercontent\.com\/[^"'`]*docs\/brain\/specs/g },
];

/**
 * INTENTIONAL_MATERIALIZATION — the surviving consumers Phase 1 catalogued (recipe:
 * `docs/brain/recipes/pm-flow-data-sources.md` §
 * "The deliberate-materialization paths"). A call site is identified by `{file, fn}`. `fn` is the
 * closest enclosing top-level function or method name. Anything else is a regression.
 *
 * Adding here REQUIRES adding the same `(file, fn, reason)` row to the recipe page — the recipe is
 * the human-readable bar, this list is the machine-readable bar; they must stay in sync.
 */
type AllowedSite = { file: string; fn: string; reason: string };
const INTENTIONAL_MATERIALIZATION: AllowedSite[] = [
  {
    file: "src/lib/brain-roadmap.ts",
    fn: "getSpec",
    reason: "spec-card preview surface — calls `serializeSpecRowToMarkdown(row)` and returns {raw, card} for in-app viewers that still expect a markdown payload",
  },
  {
    file: "src/lib/brain-roadmap.ts",
    fn: "deriveSpecStatus",
    reason: "derives status from a freshly-committed in-memory blob via `parseSpec(\"_\", raw)` — callers hold the raw markdown already (e.g. /api/roadmap/status echoing back a flip)",
  },
  {
    file: "src/lib/author-spec.ts",
    fn: "authorSpecRowFromMarkdown",
    reason: "authoring flow — calls `parseSpec` on the JUST-AUTHORED markdown blob (still in memory / read off the worktree) to derive the typed phase shape; not a disk/HTTP read of a docs/brain/specs/ file on main",
  },
  {
    file: "scripts/builder-worker.ts",
    fn: "runPlanJob",
    reason: "planner sub-agent writes proposed specs to `docs/brain/specs/` IN THE WORKTREE; the worker reads each back to author to the DB and NEVER commits the .md to main (spec-pm-markdown-purge) — round-trip materialization, not a PM-flow markdown read",
  },
  {
    file: "scripts/builder-worker.ts",
    fn: "runSpecChatJob",
    reason: "Cabbie writes the spec-chat output to `docs/brain/specs/{slug}.md` in the worktree; the worker reads it back to re-author the DB row in verify-mode — same round-trip materialization as runPlanJob",
  },
];

/**
 * PENDING_PHASE_2_RETIREMENT — empty: Phase 2 of `retire-md-reads-from-pm-flow` has landed
 * (`reconcileSpecDrift` + `runSpecDriftReconciler` + `retestOriginIfFixMerged` all read the typed
 * `specs` / `spec_phases` rows now). A new pending-retirement entry is forbidden: write the new code
 * against `getSpec` / `listSpecs` directly.
 */
const PENDING_PHASE_2_RETIREMENT: AllowedSite[] = [];

/** Combined allow-list — these (file, fn) pairs are EXEMPT from the regression check. */
const ALLOWED: Set<string> = new Set(
  [...INTENTIONAL_MATERIALIZATION, ...PENDING_PHASE_2_RETIREMENT].map((s) => `${s.file}::${s.fn}`),
);

function fail(msg: string): never {
  console.error(`\n❌ check-pm-md-reads — ${msg}\n`);
  process.exit(1);
}

function walkLib(): string[] {
  const dir = resolve(REPO_ROOT, LIB_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    fail(`could not list ${LIB_DIR}: ${(e as Error).message}`);
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".ts")) continue;
    if (e.endsWith(".test.ts")) continue;
    if (!PM_LIB_PREFIXES.some((p) => e.startsWith(p))) continue;
    out.push(join(LIB_DIR, e));
  }
  return out;
}

function walkDirRecursive(rootRel: string): string[] {
  const abs = resolve(REPO_ROOT, rootRel);
  const out: string[] = [];
  function visit(d: string) {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      let stats;
      try {
        stats = statSync(p);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        visit(p);
      } else if (stats.isFile() && name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push(relative(REPO_ROOT, p));
      }
    }
  }
  visit(abs);
  return out;
}

function pmFlowFiles(): string[] {
  const files = [
    ...walkLib(),
    ...PM_API_ROOTS.flatMap(walkDirRecursive),
    ...PM_BOX_FILES,
  ];
  return Array.from(new Set(files)).sort().map((f) => f.split(sep).join("/"));
}

/**
 * Build a (lineIdx → enclosing function name) map for `srcLines`. Recognizes top-level function
 * declarations only — `function fn`, `async function fn`, `export (async) function fn`, and the
 * top-level arrow / function-expression assigned to a name (`const fn = async (`, `const fn = (...) =>`,
 * `const fn = function`). Lines before the first declaration map to `<module>`; class methods inside
 * a class body inherit the class's outer fn (the recipe's allow-list is fn-keyed, so we'd flag a
 * method nested inside a class with that class's outer fn — none of the PM-scope hits live inside a
 * class today).
 */
function buildEnclosingFnMap(srcLines: string[]): string[] {
  // Top-level (column-0) declarations only. A `const fn = ...` indented inside another function
  // (e.g. a helper closure) is NOT a new fn for our purposes — the finding belongs to the outer
  // top-level fn. Requiring no leading whitespace nails this without brace-tracking.
  const decl = [
    // `function fn(` / `async function fn(` / `export function fn(` / `export async function fn(`
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/,
    // `const fn = function(` / `const fn = async function(` — function-expression assigned at top level
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?function\b/,
    // `const fn = (` / `const fn = async (` — arrow function assigned at top level
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?\(/,
  ];
  const out: string[] = new Array(srcLines.length).fill("<module>");
  let current = "<module>";
  for (let i = 0; i < srcLines.length; i++) {
    for (const r of decl) {
      const m = r.exec(srcLines[i]);
      if (m) {
        current = m[1];
        break;
      }
    }
    out[i] = current;
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  fn: string;
  pattern: string;
  snippet: string;
}

function scanFile(file: string): Finding[] {
  const abs = resolve(REPO_ROOT, file);
  let src: string;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const lines = src.split("\n");
  const fnMap = buildEnclosingFnMap(lines);
  const out: Finding[] = [];
  for (const { name, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(src)) !== null) {
      const offset = m.index;
      const before = src.slice(0, offset);
      const lineIdx = (before.match(/\n/g) || []).length;
      const lineText = lines[lineIdx] ?? "";
      // Skip pattern hits inside block / line comments — the recipe doc-comment in
      // brain-roadmap.ts mentions `parseSpec`, `mergePhaseStates`, etc. by name without calling them.
      const trimmed = lineText.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      // Skip the DECLARATION itself — `export function parseSpec(slug, raw)` shouldn't count as a
      // call to parseSpec. (The check enforces who CALLS the parsers; their definitions live in
      // brain-roadmap/spec-drift by design, scoped via JSDoc per Phase 2.)
      const offsetInLine = offset - (lineIdx === 0 ? 0 : src.lastIndexOf("\n", offset - 1) + 1);
      const before12 = lineText.slice(Math.max(0, offsetInLine - 12), offsetInLine);
      if (/\bfunction\s+$/.test(before12)) continue;
      out.push({
        file,
        line: lineIdx + 1,
        fn: fnMap[lineIdx],
        pattern: name,
        snippet: lineText.trim().slice(0, 160),
      });
    }
  }
  return out;
}

function summary(label: string, findings: Finding[]): string {
  return `${label} (${findings.length}): ${[...new Set(findings.map((f) => `${f.file}::${f.fn}`))].sort().join(", ")}`;
}

function main() {
  const files = pmFlowFiles();
  const findings = files.flatMap(scanFile);

  const allowed: Finding[] = [];
  const violations: Finding[] = [];
  for (const f of findings) {
    if (ALLOWED.has(`${f.file}::${f.fn}`)) allowed.push(f);
    else violations.push(f);
  }

  if (violations.length > 0) {
    console.error(`\n❌ check-pm-md-reads — ${violations.length} unexpected md-read site(s) in PM scope:\n`);
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}  in ${v.fn}  [${v.pattern}]`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\nThe PM flow reads spec state from \`public.specs\` + \`public.spec_phases\` via the typed reader\n` +
      `(\`getSpec\` / \`listSpecs\` in \`src/lib/specs-table.ts\`). NO \`docs/brain/specs/*.md\` HTTP fetch,\n` +
      `NO \`parseSpec\` over a raw blob, NO \`phaseStatesFromRaw\` over a markdown string.\n` +
      `\nIf this finding is intentional materialization, add the (file, fn, reason) triple to BOTH\n` +
      `\`INTENTIONAL_MATERIALIZATION\` in scripts/_check-pm-md-reads.ts AND the recipe table in\n` +
      `\`docs/brain/recipes/pm-flow-data-sources.md\` — the recipe is the human bar, this list is the\n` +
      `machine bar; they must agree.\n`,
    );
    console.error(`Snapshot:`);
    console.error(`  ${summary("violations", violations)}`);
    console.error(`  ${summary("allowed   ", allowed)}`);
    console.error(`  files scanned: ${files.length}\n`);
    process.exit(1);
  }

  // Hygiene: warn (not fail) on stale allow-list entries — entries that no longer match any real
  // finding. A stale entry is dead allow-list weight; the next maintainer should remove it.
  const allowedHit = new Set(allowed.map((f) => `${f.file}::${f.fn}`));
  const stale = [...INTENTIONAL_MATERIALIZATION, ...PENDING_PHASE_2_RETIREMENT].filter(
    (s) => !allowedHit.has(`${s.file}::${s.fn}`),
  );
  if (stale.length) {
    console.warn(`⚠ check-pm-md-reads — ${stale.length} stale allow-list entry/entries (no matching finding):`);
    for (const s of stale) console.warn(`  • ${s.file}::${s.fn} — ${s.reason}`);
    console.warn(`Remove from the allow-list (and the recipe table if it's an INTENTIONAL_MATERIALIZATION row).`);
  }

  console.log(
    `✓ check-pm-md-reads — ${files.length} PM-flow file(s) scanned; ` +
    `${allowed.length} allowed md-read site(s) (${INTENTIONAL_MATERIALIZATION.length} intentional, ${PENDING_PHASE_2_RETIREMENT.length} pending-retirement); ` +
    `0 unexpected.`,
  );
}

main();
