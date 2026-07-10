/**
 * Static-analysis check: NO raw PM-table WRITE outside the PM SDK.
 *
 * The PM (project-management) data — `public.specs` + `public.spec_phases` + `public.goals` +
 * `public.goal_milestones` — is the "Database is the spec" surface. Its WRITES must go through the typed
 * SDK (`src/lib/specs-table.ts` for specs/phases, `src/lib/goals-table.ts` for goals/milestones): the
 * narrow writers (`upsertSpec` / `stampPhaseShipped` / `setSpecStatus` / `setSpecBlockers` /
 * `stampSpecMergeProvenance` / `movePhase` / … on the specs side; `upsertGoal` / `setGoalStatus` /
 * `attachSpecToMilestone` / `reparentGoal` / … on the goals side). A raw `.from('specs').update(...)` (or
 * .insert / .upsert / .delete on any of the four PM tables) in agent code BYPASSES the SDK — it can skip
 * the lifecycle-override discipline (derived status from the phase rollup, stored status columns are
 * explicit overrides only) and is exactly the class this guard seals.
 *
 * SCAN SCOPE: `scripts/builder-worker.ts` + every `.ts`/`.tsx` under `src/lib`, EXCEPT the SDK internals
 * themselves (`src/lib/specs-table.ts` + `src/lib/goals-table.ts`) — those ARE the sanctioned raw writers.
 *
 * Any raw PM-table write found outside the SDK that is NOT on the explicit `SANCTIONED_RAW_WRITES`
 * allow-list (each entry carries a written reason) breaks CI red. Read-only; never mutates state.
 *
 * Wired into `npm run check:pm-sdk-compliance` + chained into `predeploy` (alongside
 * check:worker-lanes / check:pm-md-reads). Mirrors `_check-pm-md-reads.ts` / `_check-worker-lanes.ts`.
 *
 * Run:  npx tsx scripts/_check-pm-sdk-compliance.ts            # exits 1 on any unexpected violation
 *       npx tsx scripts/_check-pm-sdk-compliance.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-pm-sdk-compliance.ts. */
const REPO_ROOT = join(__dirname, "..");

/** The four PM tables whose WRITES must go through the SDK. */
const PM_TABLES = ["specs", "spec_phases", "goals", "goal_milestones"] as const;

/** The write verbs that mutate a PM table (read verbs — select — are out of scope; reads can use listSpecs). */
const WRITE_VERBS = ["update", "insert", "upsert", "delete"] as const;

/** The SDK internals — the ONLY files allowed to issue raw PM-table writes (they ARE the writers). */
const SDK_INTERNALS = new Set(["src/lib/specs-table.ts", "src/lib/goals-table.ts"]);

/**
 * Sanctioned raw-write exceptions: (file, fn, table, reason) entries. Each is a deliberate raw PM-table
 * write that is NOT routed through a narrow SDK surface, with a written justification. Keep this list
 * minimal — every entry is debt. A finding is allowed iff (file, fn, table) matches an entry here.
 */
interface SanctionedEntry {
  file: string;
  fn: string;
  table: (typeof PM_TABLES)[number];
  reason: string;
}

const SANCTIONED_RAW_WRITES: SanctionedEntry[] = [
  {
    file: "src/lib/spec-card-state.ts",
    fn: "dualWriteSpecRow",
    table: "specs",
    reason:
      "The legacy spec_card_state → specs DUAL-WRITE mirror (spec-fold-from-db-row Phase 2). It mirrors a " +
      "BROAD column set the narrow SDK surfaces don't cover in one call — status, deferred, priority, " +
      "intended_status, short_circuit(+reason), vale_pass, ada_disposition, merged_pr, last_merge_sha — " +
      "from the spec_card_state writers' flag patches. Best-effort (the spec_card_state row is the source " +
      "of truth here; the specs row catches up via upsertSpec on the next author pass). Retires when the " +
      "spec_card_state mirror is fully removed and these writers move onto the specs-table SDK.",
  },
];

/* ------------------------------------------------------------------------------------------------
 * Scope resolution.
 * --------------------------------------------------------------------------------------------- */

/** Recursively collect `*.ts(x)` files under a dir (skips node_modules / .next / dotdirs). */
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Absolute paths of every file in scan scope (builder-worker + src/lib/**), de-duped + sorted. */
function scanFiles(): string[] {
  const files = new Set<string>();
  for (const f of walkTs(join(REPO_ROOT, "src/lib"))) files.add(f);
  const worker = join(REPO_ROOT, "scripts/builder-worker.ts");
  if (existsSync(worker)) files.add(worker);
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Finding the raw writes. A write spans lines (`.from("specs")\n  .update({...})`), so we match the
 * `.from("<table>")` anchor then look for the next `.` member access (skipping comments/whitespace) and
 * check whether it's a write verb. Comment lines and string-literal mentions never carry a real
 * `.from(...).update(...)` chain, so the chain regex alone is the filter.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  table: (typeof PM_TABLES)[number];
  verb: (typeof WRITE_VERBS)[number];
  fn: string;
  snippet: string;
}

const FROM_RE = new RegExp(
  `\\.from\\(\\s*["'\`](${PM_TABLES.join("|")})["'\`]\\s*\\)`,
  "g",
);

/** Best-effort enclosing function/symbol for a 0-based line index by scanning upward. */
function enclosingFn(lines: string[], idx: number): string {
  const decl =
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(|([A-Za-z0-9_]+)\s*\([^)]*\)\s*[:{]/;
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(decl);
    if (m) {
      const name = m[1] || m[2] || m[3];
      if (name && !["if", "for", "while", "switch", "catch", "return"].includes(name)) return name;
    }
  }
  return "<module>";
}

/** Scan one file's text for raw PM-table writes. */
function findRawWrites(rel: string, text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  // Work on the whole-file text so a multi-line `.from(...)\n.verb(` chain is visible. After each
  // `.from("<table>")` match, scan forward for the next member access; if it's a write verb, record it.
  let m: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(text)) !== null) {
    const table = m[1] as (typeof PM_TABLES)[number];
    const after = text.slice(m.index + m[0].length);
    // Strip leading whitespace + line-comments to reach the next `.member(`.
    const cleaned = after.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
    const verbMatch = cleaned.match(/^\.\s*([A-Za-z]+)\s*\(/);
    if (!verbMatch) continue;
    const verb = verbMatch[1] as (typeof WRITE_VERBS)[number];
    if (!(WRITE_VERBS as readonly string[]).includes(verb)) continue;
    const line = text.slice(0, m.index).split("\n").length; // 1-based
    out.push({
      file: rel,
      line,
      table,
      verb,
      fn: enclosingFn(lines, line - 1),
      snippet: lines[line - 1].trim().slice(0, 160),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * harden-spec-submission — author through the GATE, not the raw writer. `upsertSpec` is the low-level
 * writer; authoring a spec must go through `src/lib/author-spec.ts` (`authorSpecRowStructured` / `submitSpec`
 * / `authorSpecRowFromMarkdown`) so the Verification + Intent + Parent gates and brain-ref suggester run.
 * `upsertSpec` now ALSO self-gates at runtime (throws `UngatedSpecAuthorError` on empty verification / spec
 * intent), so a raw call is a loud runtime failure — this static check is the belt to that suspenders,
 * catching a new raw caller at CI. The ONLY file allowed to call `upsertSpec` is `author-spec.ts` (the gate
 * wrapper); `specs-table.ts` (its definition) is out of scan scope already.
 * --------------------------------------------------------------------------------------------- */

/** Files allowed to call `upsertSpec` directly (the sanctioned gate wrapper). */
const UPSERT_SPEC_ALLOWED = new Set(["src/lib/author-spec.ts"]);

interface UpsertFinding {
  file: string;
  line: number;
  snippet: string;
}

/** Scan one file for a direct `upsertSpec(` invocation (not the definition, not a comment/import/type line).
 *  Tracks `/* *\/` block-comment state + strips `//` line comments so JSDoc prose that merely NAMES upsertSpec
 *  (e.g. "…via upsertSpec (idempotent)…") is never mistaken for a call. The call regex requires `upsertSpec(`
 *  with no gap, which real call sites use and prose does not. */
function findUpsertSpecCalls(rel: string, text: string): UpsertFinding[] {
  const out: UpsertFinding[] = [];
  const lines = text.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    // Consume/track block comments. If we're inside one, drop everything up to a close on this line.
    if (inBlock) {
      const end = l.indexOf("*/");
      if (end === -1) continue;
      l = l.slice(end + 2);
      inBlock = false;
    }
    // Strip inline block comments that OPEN and don't close on this line (set state), and closed ones.
    l = l.replace(/\/\*[\s\S]*?\*\//g, " ");
    const open = l.indexOf("/*");
    if (open !== -1) { inBlock = true; l = l.slice(0, open); }
    // Strip a line comment.
    const dbl = l.indexOf("//");
    if (dbl !== -1) l = l.slice(0, dbl);
    if (/\bimport\b.*upsertSpec/.test(l) || /\btype\b.*upsertSpec/.test(l)) continue; // import/type
    if (/function\s+upsertSpec\b/.test(l)) continue; // the definition (belt — it's out of scope anyway)
    if (/\bupsertSpec\(/.test(l)) out.push({ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 160) });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function isSanctioned(f: Finding): boolean {
  return SANCTIONED_RAW_WRITES.some(
    (s) => s.file === f.file && s.fn === f.fn && s.table === f.table,
  );
}

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const all: Finding[] = [];
  const upsertViolations: UpsertFinding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue; // the SDK writers — sanctioned by definition
    const text = readFileSync(abs, "utf8");
    all.push(...findRawWrites(rel, text));
    if (!UPSERT_SPEC_ALLOWED.has(rel)) upsertViolations.push(...findUpsertSpecCalls(rel, text));
  }

  const violations = all.filter((f) => !isSanctioned(f));
  const allowed = all.filter(isSanctioned);

  if (summary) {
    console.log(`PM-SDK-compliance — ${files.length} file(s) scanned, ${all.length} raw PM-write(s) found`);
    for (const f of all) {
      const tag = isSanctioned(f) ? "ALLOWED" : "VIOLATION";
      console.log(`  [${tag}] ${f.file}:${f.line}  ${f.fn}  .from('${f.table}').${f.verb}()  ${f.snippet}`);
    }
    console.log(`  upsertSpec direct calls outside author-spec.ts: ${upsertViolations.length}`);
    for (const u of upsertViolations) console.log(`  [UPSERT] ${u.file}:${u.line}  ${u.snippet}`);
  }

  if (upsertViolations.length > 0) {
    console.error(
      `\n❌ check-pm-sdk-compliance — ${upsertViolations.length} direct \`upsertSpec(\` call(s) outside the gate:\n`,
    );
    for (const u of upsertViolations) console.error(`  • ${u.file}:${u.line}  →  ${u.snippet}`);
    console.error(
      `\nAuthoring a spec must go through the [[author-spec]] chokepoint — \`authorSpecRowStructured\` /\n` +
      `\`submitSpec\` (structured) or \`authorSpecRowFromMarkdown\` (markdown) — so the Verification + Intent +\n` +
      `Parent gates and the brain-ref suggester run. \`upsertSpec\` is the low-level writer (it now ALSO\n` +
      `self-gates at runtime, throwing UngatedSpecAuthorError on empty verification/intent). Only\n` +
      `\`src/lib/author-spec.ts\` may call it directly. Retarget this call to \`submitSpec\`.\n`,
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(`\n❌ check-pm-sdk-compliance — ${violations.length} raw PM-table write(s) outside the SDK:\n`);
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}  in ${v.fn}  →  .from('${v.table}').${v.verb}()`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\nPM data WRITES go through the SDK: \`src/lib/specs-table.ts\` (specs/spec_phases) +\n` +
      `\`src/lib/goals-table.ts\` (goals/goal_milestones). Use the narrow writer for the field you're\n` +
      `setting — setSpecStatus / setSpecBlockers / stampSpecMergeProvenance / stampPhaseShipped /\n` +
      `upsertSpec on the specs side; setGoalStatus / upsertGoal / attachSpecToMilestone on the goals side.\n` +
      `\nDerived status comes from the phase rollup; the stored status columns are EXPLICIT lifecycle\n` +
      `overrides only (in_review / deferred / folded). If a raw write is genuinely unavoidable, add the\n` +
      `(file, fn, table, reason) entry to SANCTIONED_RAW_WRITES in this script with a written reason.\n`,
    );
    process.exit(1);
  }

  // Hygiene: warn (not fail) on stale allow-list entries — sanctioned entries matching no real finding.
  const hit = new Set(allowed.map((f) => `${f.file}::${f.fn}::${f.table}`));
  const stale = SANCTIONED_RAW_WRITES.filter((s) => !hit.has(`${s.file}::${s.fn}::${s.table}`));
  if (stale.length) {
    console.warn(`⚠ check-pm-sdk-compliance — ${stale.length} stale allow-list entry/entries (no matching finding):`);
    for (const s of stale) console.warn(`  • ${s.file}::${s.fn} [${s.table}] — ${s.reason}`);
    console.warn(`Remove from SANCTIONED_RAW_WRITES — the raw write it sanctioned is gone.`);
  }

  console.log(
    `✓ check-pm-sdk-compliance — ${files.length} file(s) scanned; ` +
    `${allowed.length} sanctioned raw PM-write(s) (allow-listed); 0 unexpected.`,
  );
}

main();
