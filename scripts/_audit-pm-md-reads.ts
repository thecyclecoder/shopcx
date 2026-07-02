/**
 * Read-only inventory of every markdown-read site in the PM (project-management) flow —
 * the Phase 1 artifact of [[../specs/retire-md-reads-from-pm-flow]] (public.specs slug
 * `retire-md-reads-from-pm-flow`, spec_phases position 1).
 *
 * "Database is the spec." The PM flow (every code path that reads a spec to advance, render, or
 * reconcile its state) is supposed to consume `public.specs` + `public.spec_phases` directly via the
 * typed reader (`getSpec` / `listSpecs` in [[../src/lib/specs-table.ts]]) — never a
 * `docs/brain/specs/*.md` HTTP fetch, never `parseSpec` over a raw blob, never `phaseStatesFromRaw`
 * over a markdown string. This script makes the surviving md-read surface VISIBLE before Phase 2
 * deletes it, and stays committed afterwards as the catalogue Phase 3's coverage check
 * (`_check-pm-md-reads.ts`) enforces against.
 *
 * Mirrors the `_check-worker-lanes.ts` coverage-check shape (same spec family). READ-ONLY by
 * construction: it greps the working tree and emits a JSON manifest to stdout. It performs NO DB
 * writes, NO git ops, NO file mutations.
 *
 * Run:  npx tsx scripts/_audit-pm-md-reads.ts            # full JSON manifest to stdout
 *       npx tsx scripts/_audit-pm-md-reads.ts --summary  # one-line-per-site summary
 *
 * Consumed by `scripts/_check-pm-md-reads.ts` (Phase 3 coverage check) which imports
 * `buildManifest`, `INTENTIONAL_MATERIALIZATION`, and `PENDING_PHASE_2_RETIREMENT` from here —
 * one source of truth for the file set, the patterns, and the allow-lists.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_audit-pm-md-reads.ts. */
const REPO_ROOT = join(__dirname, "..");

/* ------------------------------------------------------------------------------------------------
 * The PM-flow file set (spec Phase 1 body).
 *
 *   src/lib/{spec-,specs-,spec_,pm-,brain-roadmap,agent-jobs,author-,build-spec-materializer}*.ts
 *   src/app/api/roadmap/**
 *   src/app/api/specs/**
 *   scripts/builder-worker.ts   (the box's PM-touching helpers)
 *
 * Resolved against the working tree at run time so the inventory tracks reality, not a frozen list.
 * --------------------------------------------------------------------------------------------- */

/** `src/lib` basename prefixes that put a `.ts` file in PM scope. */
const LIB_PREFIXES = [
  "spec-",
  "specs-",
  "spec_",
  "pm-",
  "brain-roadmap",
  "agent-jobs",
  "author-",
  "build-spec-materializer",
];

/** Recursively collect `*.ts` files under a dir (skips `node_modules`/`.next`/dotdirs). */
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

/** Absolute paths of every file in PM scope, de-duped + sorted. */
export function pmFlowFiles(): string[] {
  const files = new Set<string>();

  const libDir = join(REPO_ROOT, "src/lib");
  if (existsSync(libDir)) {
    for (const entry of readdirSync(libDir)) {
      if (!entry.endsWith(".ts")) continue;
      if (LIB_PREFIXES.some((p) => entry.startsWith(p))) files.add(join(libDir, entry));
    }
  }

  for (const apiDir of ["src/app/api/roadmap", "src/app/api/specs"]) {
    for (const f of walkTs(join(REPO_ROOT, apiDir))) files.add(f);
  }

  const worker = join(REPO_ROOT, "scripts/builder-worker.ts");
  if (existsSync(worker)) files.add(worker);

  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * The md-read patterns (spec Phase 1 body). Each match is a candidate call site.
 * --------------------------------------------------------------------------------------------- */

export interface MdPattern {
  /** Stable key recorded on each finding. */
  id: string;
  /** Regex tested per line. */
  re: RegExp;
  /** Human description of what the pattern indicates. */
  what: string;
}

export const MD_PATTERNS: MdPattern[] = [
  { id: "specs-md-literal", re: /docs\/brain\/specs\//, what: "literal docs/brain/specs/ path" },
  { id: "fetchSpecRawFromMain", re: /fetchSpecRawFromMain\s*\(/, what: "raw-from-main spec fetch" },
  { id: "parseSpec", re: /\b(?:parseSpec|parseAuthoredSpecMarkdown)\s*\(/, what: "authored-markdown parser over a spec blob" },
  { id: "phaseStatesFromRaw", re: /\bphaseStatesFromRaw\s*\(/, what: "phaseStatesFromRaw() over markdown" },
  { id: "mergePhaseStates", re: /\bmergePhaseStates\s*\(/, what: "mergePhaseStates() merge of md-derived states" },
  { id: "serializeSpecRowToMarkdown", re: /\bserializeSpecRowToMarkdown\s*\(/, what: "DB row → markdown materialization" },
  {
    // readFile / readFileSync of ANY .md path. The classifier decides whether the path is a SPEC/GOAL
    // markdown (a PM spec-state read → retire candidate) or an unrelated .md — an org-chart function
    // definition under FUNCTIONS_DIR, or a folded-spec archive page — which is a documented non-PM
    // consumer (`non-pm-consumer-investigate`), surfaced for visibility but not a retirement target.
    id: "readFile-md",
    re: /\breadFile(?:Sync)?\s*\([^)]*\.md\b/,
    what: "readFile(Sync) of a .md path",
  },
  {
    // A raw GitHub URL that reads a spec markdown blob.
    id: "raw-github-spec",
    re: /raw\.githubusercontent\.com[^"'`]*specs?[^"'`]*\.md/,
    what: "raw GitHub URL read of a spec .md",
  },
];

/**
 * For a `readFile-md` finding, decide whether the path being read is a SPEC/GOAL markdown (a PM
 * spec-state read → retire candidate) versus an unrelated `.md` (function definition / fold archive →
 * non-PM consumer). Keyed off the markers visible on the readFile line.
 */
function readsSpecMarkdown(snippet: string): boolean {
  if (/FUNCTIONS_DIR|ARCHIVE_DIR|ARCHIVE_FILE/.test(snippet)) return false; // functions + fold archive
  return /docs\/brain\/specs|specPath|SPECS?_DIR|spec-\$\{|spec_/.test(snippet);
}

/**
 * A line is a retired-READER DEFINITION (not a consumer call site) when it DECLARES one of the markdown
 * STATE readers — `export function parseSpec(...)`, `phaseStatesFromRaw(...)`, `mergePhaseStates(...)`,
 * `fetchSpecRawFromMain(...)`. The declaration is the thing being retired, not a consumer of it; counting
 * it would falsely report a `pm-read-to-retire`. `serializeSpecRowToMarkdown` is DELIBERATELY NOT skipped
 * — the recipe lists its definition as the first intentional-materialization row, so it's counted +
 * allow-listed (the allow-list and the findings stay in agreement, no stale-entry warning).
 */
function isDefinitionLine(line: string): boolean {
  return /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:parseSpec|parseAuthoredSpecMarkdown|phaseStatesFromRaw|mergePhaseStates|fetchSpecRawFromMain)\b/.test(
    line,
  );
}

/* ------------------------------------------------------------------------------------------------
 * Allow-lists. (file, fn, reason) triples. Exported for `_check-pm-md-reads.ts`.
 *
 *  - INTENTIONAL_MATERIALIZATION: legitimate, permanent DB-row → markdown materialization for AGENT
 *    INPUT (the box renders a DB spec to a scratch .md the headless `claude -p` agent Reads, or reads
 *    back a .md the agent AUTHORED to upsert into the DB). These are `materialization-for-agent-input`
 *    and SURVIVE the retirement — the markdown is a transport buffer, not a state read.
 *  - PENDING_PHASE_2_RETIREMENT: md-read state sites Phase 2 is expected to delete. Pre-populated empty
 *    on `main` post-Phase-2 (the reads were already retired); kept as the slot the audit + the check
 *    agree on. If a regression re-introduces a real state read, it lands here (then gets deleted).
 *
 * Both are matched by `file` (repo-relative) + `fn` (enclosing function name).
 * --------------------------------------------------------------------------------------------- */

export interface AllowEntry {
  file: string;
  fn: string;
  reason: string;
}

export const INTENTIONAL_MATERIALIZATION: AllowEntry[] = [
  {
    file: "src/lib/brain-roadmap.ts",
    fn: "serializeSpecRowToMarkdown",
    reason:
      "The DB-row → markdown serializer itself. Renders a typed SpecRow back to a markdown blob for the " +
      "agent-input transport buffer (the .box/spec-{slug}.md the headless build/fold agent Reads). Not a " +
      "state read — the row is the source of truth. Recipe: pm-flow-data-sources § deliberate-materialization.",
  },
  {
    file: "src/lib/brain-roadmap.ts",
    fn: "getSpec",
    reason:
      "The spec-card preview surface — returns { raw, card } where raw = serializeSpecRowToMarkdown(row) " +
      "for views that still expect a markdown payload (board card preview, in-app spec viewers). The card " +
      "is read from the DB row; the markdown is materialized FROM it, never parsed back into state.",
  },
  {
    file: "src/lib/brain-roadmap.ts",
    fn: "deriveSpecStatusFromMarkdown",
    reason:
      "parseAuthoredSpecMarkdown over an IN-MEMORY raw string (no disk read) — the same deriveStatus the board " +
      "uses, exposed for callers holding freshly-committed content (e.g. platform-director's would-this-fold " +
      "check against a groom split's rewritten parent). Round-trip materialization, not a spec/*.md fetch.",
  },
  {
    // The AUTHORING round-trip: parseSpec over agent-AUTHORED markdown to UPSERT into public.specs +
    // public.spec_phases (author-spec.ts:304, inside authorSpecRowFromMarkdown). The enclosing-function
    // detector labels this call site by the nearest in-function `// ENFORCEMENT` comment, not the fn name —
    // so the allow entry keys on `ENFORCEMENT`. spec-readers-from-db-retire-parser Phase 3 makes parseSpec
    // formally authoring-only, so this materialization call site is intentionally allow-listed.
    file: "src/lib/author-spec.ts",
    fn: "ENFORCEMENT",
    reason:
      "The AUTHORING round-trip: parseSpec over agent-AUTHORED markdown to UPSERT into public.specs + " +
      "public.spec_phases. The markdown is the agent's output buffer being written INTO the DB, not a spec " +
      "state READ (the detector labels the call site by the in-function `// ENFORCEMENT` comment, not the fn " +
      "name). Recipe: pm-flow-data-sources § round-trip materialization.",
  },
];

export const PENDING_PHASE_2_RETIREMENT: AllowEntry[] = [];

/* ------------------------------------------------------------------------------------------------
 * Manifest types + builder.
 * --------------------------------------------------------------------------------------------- */

export type Classification =
  | "pm-read-to-retire"
  | "materialization-for-agent-input"
  | "non-pm-consumer-investigate";

export interface Finding {
  line: number;
  pattern: string;
  /** What the pattern indicates (from MD_PATTERNS.what). */
  what: string;
  snippet: string;
  /** Whether the matched line is a comment or lives inside a prompt/template string (a mention, not a read). */
  is_mention: boolean;
}

export interface CallSite {
  /** Repo-relative path. */
  file: string;
  /** Enclosing function/symbol name (best-effort), or "<module>". */
  fn: string;
  classification: Classification;
  findings: Finding[];
}

export interface Manifest {
  generated_at: string;
  scanned_files: number;
  /** keyed `"<file>::<fn>"`. */
  by_call_site: Record<string, CallSite>;
  counts: Record<Classification, number>;
}

/** Strip a leading line-number tab and detect comment / prompt-string lines (mentions, not reads). */
function isMentionLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return true;
  return false;
}

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

/**
 * Classify a call site. Heuristic, deliberately conservative:
 *  - In the allow-lists → materialization-for-agent-input.
 *  - All findings are mentions (comments / prompt strings, no executable read) → non-pm-consumer-investigate.
 *  - A real read (readFile/fetch/parse over markdown) that is NOT allow-listed → pm-read-to-retire.
 *  - Otherwise (serialize / materialize helpers not on the allow-list) → materialization-for-agent-input.
 */
function classify(file: string, fn: string, findings: Finding[]): Classification {
  const allow = [...INTENTIONAL_MATERIALIZATION, ...PENDING_PHASE_2_RETIREMENT];
  if (allow.some((a) => a.file === file && a.fn === fn)) return "materialization-for-agent-input";

  const executable = findings.filter((f) => !f.is_mention);
  if (executable.length === 0) return "non-pm-consumer-investigate";

  // A finding is a SPEC-STATE READ (a Phase-2 retirement target) only when it reads spec/goal markdown.
  const STATE_READ_PATTERNS = new Set([
    "fetchSpecRawFromMain",
    "parseSpec",
    "phaseStatesFromRaw",
    "raw-github-spec",
  ]);
  const MATERIALIZE = new Set(["serializeSpecRowToMarkdown"]);

  function isStateRead(f: Finding): boolean {
    if (f.pattern === "readFile-md") return readsSpecMarkdown(f.snippet);
    return STATE_READ_PATTERNS.has(f.pattern);
  }

  const hasStateRead = executable.some(isStateRead);
  const onlyMaterialize = executable.every((f) => MATERIALIZE.has(f.pattern));

  if (onlyMaterialize) return "materialization-for-agent-input";
  if (hasStateRead) return "pm-read-to-retire";
  return "non-pm-consumer-investigate";
}

/** Walk the PM-flow file set, grep the patterns, build the manifest grouped by call site. */
export function buildManifest(): Manifest {
  const files = pmFlowFiles();
  const bySite: Record<string, CallSite> = {};

  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // The line that DECLARES a retired/allow-listed symbol is not a consumer of it — skip it so the
      // symbol's own definition doesn't double-report as a read site.
      if (isDefinitionLine(line)) continue;
      for (const pat of MD_PATTERNS) {
        if (!pat.re.test(line)) continue;
        const fn = enclosingFn(lines, i);
        const key = `${rel}::${fn}`;
        const finding: Finding = {
          line: i + 1,
          pattern: pat.id,
          what: pat.what,
          snippet: line.trim().slice(0, 200),
          is_mention: isMentionLine(line),
        };
        if (!bySite[key]) {
          bySite[key] = { file: rel, fn, classification: "non-pm-consumer-investigate", findings: [] };
        }
        bySite[key].findings.push(finding);
      }
    }
  }

  // Classify each site once all findings are collected.
  for (const site of Object.values(bySite)) {
    site.classification = classify(site.file, site.fn, site.findings);
  }

  const counts: Record<Classification, number> = {
    "pm-read-to-retire": 0,
    "materialization-for-agent-input": 0,
    "non-pm-consumer-investigate": 0,
  };
  for (const site of Object.values(bySite)) counts[site.classification]++;

  return {
    generated_at: new Date().toISOString(),
    scanned_files: files.length,
    by_call_site: bySite,
    counts,
  };
}

/* ------------------------------------------------------------------------------------------------
 * CLI — read-only. Prints the JSON manifest (or a --summary view) to stdout.
 * --------------------------------------------------------------------------------------------- */

function main() {
  const summary = process.argv.includes("--summary");
  const jsonl = process.argv.includes("--jsonl");
  const manifest = buildManifest();

  if (jsonl) {
    // One finding per line (file, line, fn, pattern, classification) — grep/awk-friendly.
    for (const site of Object.values(manifest.by_call_site)) {
      for (const f of site.findings) {
        console.log(
          JSON.stringify({
            file: site.file,
            line: f.line,
            fn: site.fn,
            pattern: f.pattern,
            classification: site.classification,
            is_mention: f.is_mention,
            snippet: f.snippet,
          }),
        );
      }
    }
    return;
  }

  if (summary) {
    console.log(
      `PM-flow md-read audit — ${manifest.scanned_files} files scanned, ` +
        `${Object.keys(manifest.by_call_site).length} call site(s)\n` +
        `  pm-read-to-retire:              ${manifest.counts["pm-read-to-retire"]}\n` +
        `  materialization-for-agent-input:${manifest.counts["materialization-for-agent-input"]}\n` +
        `  non-pm-consumer-investigate:    ${manifest.counts["non-pm-consumer-investigate"]}\n`,
    );
    for (const site of Object.values(manifest.by_call_site).sort((a, b) =>
      `${a.file}::${a.fn}`.localeCompare(`${b.file}::${b.fn}`),
    )) {
      console.log(`[${site.classification}] ${site.file}::${site.fn}`);
      for (const f of site.findings) {
        console.log(`    ${site.file}:${f.line}  [${f.pattern}]${f.is_mention ? " (mention)" : ""}  ${f.snippet}`);
      }
    }
    return;
  }

  console.log(JSON.stringify(manifest, null, 2));
}

if (require.main === module) main();
