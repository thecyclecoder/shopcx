/**
 * Static-analysis check: NO raw `ticket_analyses` WRITE outside the ticket-analyses SDK.
 *
 * Phase 2 of docs/brain/specs/ticket-analyzer-becomes-box-agent-under-june.md. The single sanctioned
 * WRITE surface for `public.ticket_analyses` is `src/lib/ticket-analyses-table.ts`
 * (`insertAnalysis` / `applyAdminOverride` / `applyAgentRescore`). A raw
 * `.from('ticket_analyses').insert(…)` / `.update(…)` / `.upsert(…)` / `.delete(…)` in agent code
 * BYPASSES the SDK — it can skip the compare-and-set + workspace-scoped guards and let a
 * cross-workspace id sneak flip a foreign row. This guard seals that class.
 *
 * SCAN SCOPE: `scripts/builder-worker.ts` + every `.ts`/`.tsx` under `src/lib` + `src/app`, EXCEPT
 * the SDK internals themselves (`src/lib/ticket-analyses-table.ts`) — that IS the sanctioned raw
 * writer.
 *
 * Read verbs are OUT of scope: the SDK exposes `getLatestForTicket` + `listForTicket`, but callers
 * that only read via a projection are free to keep a raw `.select(…)` chain — the guard is
 * write-only (mirrors `_check-pm-sdk-compliance.ts`'s WRITE_VERBS scope).
 *
 * Any raw ticket_analyses WRITE found outside the SDK that is NOT on the explicit
 * `SANCTIONED_RAW_WRITES` allow-list breaks CI red. Read-only; never mutates state.
 *
 * Run:  npx tsx scripts/_check-ticket-analyses-sdk-compliance.ts            # exits 1 on any unexpected violation
 *       npx tsx scripts/_check-ticket-analyses-sdk-compliance.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-ticket-analyses-sdk-compliance.ts. */
const REPO_ROOT = join(__dirname, "..");

const TABLE = "ticket_analyses" as const;

/** The write verbs that mutate the table (reads — select — are out of scope; use listForTicket / getLatestForTicket). */
const WRITE_VERBS = ["update", "insert", "upsert", "delete"] as const;

/** The SDK internals — the ONLY file allowed to issue raw ticket_analyses writes (it IS the writer). */
const SDK_INTERNALS = new Set(["src/lib/ticket-analyses-table.ts"]);

/**
 * Sanctioned raw-write exceptions: (file, fn, reason) entries. Each is a deliberate raw write that
 * is NOT routed through the SDK, with a written justification. Keep this list minimal — every
 * entry is debt. A finding is allowed iff (file, fn) matches an entry here.
 */
interface SanctionedEntry {
  file: string;
  fn: string;
  reason: string;
}

const SANCTIONED_RAW_WRITES: SanctionedEntry[] = [
  {
    file: "scripts/fix-pause-policy-and-grader.ts",
    fn: "main",
    reason:
      "One-off operator script (retro-fix of a specific ticket_analyses row's admin_score after a " +
      "policy update). The scripts/*.ts one-offs are archival — they don't run in the request path — " +
      "so routing them through the SDK is churn without a safety win. If the pattern recurs, promote " +
      "the write to applyAdminOverride and remove this entry.",
  },
];

/* ------------------------------------------------------------------------------------------------
 * Scope resolution.
 * --------------------------------------------------------------------------------------------- */

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
  // Scan the fix-* / _* scripts too so the allow-list actually catches its own sanctioned entry.
  for (const f of walkTs(join(REPO_ROOT, "scripts"))) files.add(f);
  // Skip the compliance script itself — its docstring mentions `.from('ticket_analyses').insert(…)`
  // in prose that the regex otherwise matches as a "raw write". The finder walks a simple
  // pattern; a scanner scanning its own text is not the SDK boundary we're guarding.
  files.delete(join(REPO_ROOT, "scripts/_check-ticket-analyses-sdk-compliance.ts"));
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Finding the raw writes. A write spans lines (`.from("ticket_analyses")\n  .update({...})`), so
 * we match the `.from("<table>")` anchor then look for the next `.` member access (skipping
 * comments/whitespace) and check whether it's a write verb.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  verb: (typeof WRITE_VERBS)[number];
  fn: string;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`](${TABLE})["'\`]\\s*\\)`, "g");

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
    const after = text.slice(m.index + m[0].length);
    const cleaned = after.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
    const verbMatch = cleaned.match(/^\.\s*([A-Za-z]+)\s*\(/);
    if (!verbMatch) continue;
    const verb = verbMatch[1] as (typeof WRITE_VERBS)[number];
    if (!(WRITE_VERBS as readonly string[]).includes(verb)) continue;
    const line = text.slice(0, m.index).split("\n").length; // 1-based
    out.push({
      file: rel,
      line,
      verb,
      fn: enclosingFn(lines, line - 1),
      snippet: lines[line - 1].trim().slice(0, 160),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function isSanctioned(f: Finding): boolean {
  return SANCTIONED_RAW_WRITES.some((s) => s.file === f.file && s.fn === f.fn);
}

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const all: Finding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue; // the SDK writer — sanctioned by definition
    // The compliance script itself references .from('ticket_analyses') in the FROM_RE / prose but
    // never as a member-access chain, so the finder won't match — no explicit skip needed.
    all.push(...findRawWrites(rel, readFileSync(abs, "utf8")));
  }

  const violations = all.filter((f) => !isSanctioned(f));
  const allowed = all.filter(isSanctioned);

  if (summary) {
    console.log(`ticket-analyses-SDK-compliance — ${files.length} file(s) scanned, ${all.length} raw ${TABLE}-write(s) found`);
    for (const f of all) {
      const tag = isSanctioned(f) ? "ALLOWED" : "VIOLATION";
      console.log(`  [${tag}] ${f.file}:${f.line}  ${f.fn}  .from('${TABLE}').${f.verb}()  ${f.snippet}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ check-ticket-analyses-sdk-compliance — ${violations.length} raw ${TABLE}-write(s) outside the SDK:\n`);
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}  in ${v.fn}  →  .from('${TABLE}').${v.verb}()`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\n${TABLE} WRITES go through the SDK: \`src/lib/ticket-analyses-table.ts\`.\n` +
      `Use the narrow writer for the mutation: insertAnalysis (fresh row from analyzer verdict) /\n` +
      `applyAdminOverride (human score override, compare-and-set) / applyAgentRescore (agent-proposed\n` +
      `rescore, compare-and-set). If a raw write is genuinely unavoidable, add the (file, fn, reason)\n` +
      `entry to SANCTIONED_RAW_WRITES in this script with a written reason.\n`,
    );
    process.exit(1);
  }

  const hit = new Set(allowed.map((f) => `${f.file}::${f.fn}`));
  const stale = SANCTIONED_RAW_WRITES.filter((s) => !hit.has(`${s.file}::${s.fn}`));
  if (stale.length) {
    console.warn(`⚠ check-ticket-analyses-sdk-compliance — ${stale.length} stale allow-list entry/entries:`);
    for (const s of stale) console.warn(`  • ${s.file}::${s.fn} — ${s.reason}`);
    console.warn(`Remove from SANCTIONED_RAW_WRITES — the raw write it sanctioned is gone.`);
  }

  console.log(
    `✓ check-ticket-analyses-sdk-compliance — ${files.length} file(s) scanned; ` +
    `${allowed.length} sanctioned raw ${TABLE}-write(s) (allow-listed); 0 unexpected.`,
  );
}

main();
