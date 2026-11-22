/**
 * Static-analysis check: NO raw write to the customer-lifecycle experiment tables outside the
 * subscriber-experiments SDK.
 *
 * Phase 2 of the subscriber-experiment-harness spec. The single sanctioned WRITE surface for
 * `public.customer_lifecycle_experiments` + `public.customer_lifecycle_experiment_assignments` is
 * `src/lib/subscriber-experiments.ts` (`createExperiment` / `assignArm`). A raw
 * `.from('customer_lifecycle_experiment*').insert(…)/.update(…)/.upsert(…)/.delete(…)` elsewhere
 * BYPASSES the chokepoint — it can duplicate or silently flip a sticky arm, breaking the
 * fixed-at-first-eligibility guarantee the UNIQUE (experiment_id, group_id) constraint + SDK
 * enforce (CLAUDE.md raw-`.from` STOP rule). This guard seals that class — same spirit as
 * `_check-ticket-analyses-sdk-compliance.ts` / `_check-competitors-sdk-compliance.ts`.
 *
 * SCAN SCOPE: `scripts/builder-worker.ts` + every `.ts`/`.tsx` under `src/lib` + `src/app` + the
 * `scripts/` one-offs, EXCEPT the SDK internals themselves (`src/lib/subscriber-experiments.ts`).
 * Read verbs (select) are OUT of scope.
 *
 * Run:  npx tsx scripts/_check-subscriber-experiments-sdk-compliance.ts            # exits 1 on any unexpected violation
 *       npx tsx scripts/_check-subscriber-experiments-sdk-compliance.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");

/** The two person-level experiment tables guarded by this SDK. */
const TABLES = ["customer_lifecycle_experiments", "customer_lifecycle_experiment_assignments"] as const;

/** The write verbs that mutate a table (reads — select — are out of scope). */
const WRITE_VERBS = ["update", "insert", "upsert", "delete"] as const;

/** The SDK internals — the ONLY file allowed to issue raw writes to these tables (it IS the writer). */
const SDK_INTERNALS = new Set(["src/lib/subscriber-experiments.ts"]);

interface SanctionedEntry {
  file: string;
  fn: string;
  reason: string;
}

/** Sanctioned raw-write exceptions — keep minimal; every entry is debt. Empty by design. */
const SANCTIONED_RAW_WRITES: SanctionedEntry[] = [];

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

function scanFiles(): string[] {
  const files = new Set<string>();
  for (const f of walkTs(join(REPO_ROOT, "src/lib"))) files.add(f);
  for (const f of walkTs(join(REPO_ROOT, "src/app"))) files.add(f);
  const worker = join(REPO_ROOT, "scripts/builder-worker.ts");
  if (existsSync(worker)) files.add(worker);
  for (const f of walkTs(join(REPO_ROOT, "scripts"))) files.add(f);
  // Skip this guard itself — its prose mentions `.from('customer_lifecycle_experiment*').insert(…)`.
  files.delete(join(REPO_ROOT, "scripts/_check-subscriber-experiments-sdk-compliance.ts"));
  return [...files].sort();
}

interface Finding {
  file: string;
  line: number;
  table: string;
  verb: (typeof WRITE_VERBS)[number];
  fn: string;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`](${TABLES.join("|")})["'\`]\\s*\\)`, "g");

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

function findRawWrites(rel: string, text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  let m: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(text)) !== null) {
    const table = m[1];
    const after = text.slice(m.index + m[0].length);
    const cleaned = after.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
    const verbMatch = cleaned.match(/^\.\s*([A-Za-z]+)\s*\(/);
    if (!verbMatch) continue;
    const verb = verbMatch[1] as (typeof WRITE_VERBS)[number];
    if (!(WRITE_VERBS as readonly string[]).includes(verb)) continue;
    const line = text.slice(0, m.index).split("\n").length;
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

function isSanctioned(f: Finding): boolean {
  return SANCTIONED_RAW_WRITES.some((s) => s.file === f.file && s.fn === f.fn);
}

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const all: Finding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue;
    all.push(...findRawWrites(rel, readFileSync(abs, "utf8")));
  }

  const violations = all.filter((f) => !isSanctioned(f));
  const allowed = all.filter(isSanctioned);

  if (summary) {
    console.log(`subscriber-experiments-SDK-compliance — ${files.length} file(s) scanned, ${all.length} raw write(s) found`);
    for (const f of all) {
      const tag = isSanctioned(f) ? "ALLOWED" : "VIOLATION";
      console.log(`  [${tag}] ${f.file}:${f.line}  ${f.fn}  .from('${f.table}').${f.verb}()  ${f.snippet}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ check-subscriber-experiments-sdk-compliance — ${violations.length} raw write(s) outside the SDK:\n`);
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}  in ${v.fn}  →  .from('${v.table}').${v.verb}()`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\nThese writes go through the SDK: \`src/lib/subscriber-experiments.ts\`.\n` +
      `Use createExperiment (stamps the pre-registered power calc + stop rule) / assignArm (sticky\n` +
      `per-group arm, honours the kill switch). A raw write bypasses the sticky-assignment guard\n` +
      `and can duplicate or flip a fixed arm. If genuinely unavoidable, add the (file, fn, reason)\n` +
      `entry to SANCTIONED_RAW_WRITES with a written reason.\n`,
    );
    process.exit(1);
  }

  const hit = new Set(allowed.map((f) => `${f.file}::${f.fn}`));
  const stale = SANCTIONED_RAW_WRITES.filter((s) => !hit.has(`${s.file}::${s.fn}`));
  if (stale.length) {
    console.warn(`⚠ check-subscriber-experiments-sdk-compliance — ${stale.length} stale allow-list entry/entries:`);
    for (const s of stale) console.warn(`  • ${s.file}::${s.fn} — ${s.reason}`);
  }

  console.log(
    `✓ check-subscriber-experiments-sdk-compliance — ${files.length} file(s) scanned; ` +
    `${allowed.length} sanctioned raw write(s) (allow-listed); 0 unexpected.`,
  );
}

main();
