/**
 * Static-analysis check: NO NEW lossy `[object Object]` catch-site renderer.
 *
 * lossless-error-diagnostics-no-object-object Phase 3 — Phase 1 landed the shared `errText()`
 * renderer (`src/lib/error-text.ts`) and Phase 2 converted every existing lossy site. Without
 * this rail, a new lane written by copy-paste from the old pattern silently re-introduces
 * `writeDirection failed: [object Object]` (the originating incident on Sol's session dfa7d984 —
 * a supabase-js PostgREST error is a PLAIN object, not an Error, so the legacy
 * `X instanceof Error ? X.message : String(X)` ternary destroys the code/details/hint at the
 * exact moment a supervisor needs them).
 *
 * WHAT WE FLAG:
 *   (a) the LOSSY TERNARY in any variable-name variant — `X instanceof Error ? X.message : String(X)`.
 *   (b) the narrower FOOTGUN — a bare `String(<caught-binding>)` INSIDE a `catch (<caught-binding>)`
 *       block (same defect, written without the ternary).
 *
 * ESCAPE HATCH: a `// lossy-error-ok: <reason>` line-comment on the SAME line or the LINE ABOVE
 * the match is honored — the rare site where the caught value is provably a string. The guard is
 * satisfiable without weakening it.
 *
 * SCAN SCOPE: every `.ts`/`.tsx` under `src/` and `scripts/`, EXCEPT:
 *   - the guard's own file (this one), which names the pattern in its docstring.
 *   - `src/lib/error-text.ts` — the shared renderer whose JSDoc header names the anti-pattern in
 *     the WHY (skipped rather than escape-hatched because a whole doc block would need a hatch).
 *   - `*.test.ts` / `*.spec.ts` — a test may exercise the anti-pattern on purpose (e.g. errText's
 *     own tests construct the ternary's SHAPE via a plain object; we do not care).
 *
 * Read-only; never mutates state. Wired into `npm run check:no-lossy-error-stringify` + chained
 * into `predeploy`. Mirrors `_check-no-markdown-spec-authoring.ts`.
 *
 * Run:  npx tsx scripts/_check-no-lossy-error-stringify.ts             # exits 1 on any violation
 *       npx tsx scripts/_check-no-lossy-error-stringify.ts --summary   # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-no-lossy-error-stringify.ts. */
const REPO_ROOT = join(__dirname, "..");

/** Files skipped even though they match the scan scope. */
const SKIP_FILES = new Set<string>([
  "scripts/_check-no-lossy-error-stringify.ts", // this file
  "src/lib/error-text.ts", // the shared renderer whose JSDoc names the anti-pattern
]);

/** The lossy ternary in any variable-name variant. Matches only when all three positions carry
 *  the SAME identifier (backreference), so `e`, `err`, `blkErr`, `linkErr`, etc. are one rule. */
const TERNARY = /\b(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\s*\1\s*\)/g;

/** Same-line-or-line-above escape hatch, matching CLAUDE.md § "lossy-error-ok" convention. */
const ESCAPE = /\/\/\s*lossy-error-ok\b/;

/** `catch (<name>)` or `catch (<name>: unknown)` (TS allows only `unknown`/`any` on a catch
 *  binding, so `[^)]*` is safe for the annotation). Non-global — used repeatedly with lastIndex. */
const CATCH = /\bcatch\s*\(\s*(\w+)\s*(?::\s*[^)]+)?\s*\)\s*\{/g;

/* ------------------------------------------------------------------------------------------------
 * Scope resolution — mirrors _check-no-markdown-spec-authoring / _check-pm-sdk-compliance.
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
  for (const root of ["src", "scripts"]) {
    for (const abs of walkTs(join(REPO_ROOT, root))) {
      if (/\.(test|spec)\.tsx?$/.test(abs)) continue;
      files.add(abs);
    }
  }
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Findings.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  kind: "ternary" | "catch-string";
  snippet: string;
  binding: string;
}

/** Compute 1-based line number for a char index in `text`. Cheap linear scan — files are small
 *  enough that a prefix-sum isn't worth the extra state. */
function lineOf(text: string, idx: number): number {
  let line = 1;
  const cap = Math.min(idx, text.length);
  for (let i = 0; i < cap; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** True if the match is inside a line comment (`//`) or a JSDoc continuation line (`* …`). */
function inCommentContext(lineText: string, colIdx: number): boolean {
  if (/^\s*\*(?:\s|$)/.test(lineText)) return true; // JSDoc continuation
  const commentStart = lineText.indexOf("//");
  if (commentStart !== -1 && commentStart < colIdx) return true;
  return false;
}

/** True if `line` (1-based) has the escape hatch on same/previous line. */
function hasEscape(lines: string[], line: number): boolean {
  const cur = lines[line - 1] ?? "";
  const prev = lines[line - 2] ?? "";
  return ESCAPE.test(cur) || ESCAPE.test(prev);
}

function findTernaries(rel: string, text: string, lines: string[]): Finding[] {
  const out: Finding[] = [];
  TERNARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERNARY.exec(text))) {
    const line = lineOf(text, m.index);
    const cur = lines[line - 1] ?? "";
    const colIdx = cur.indexOf(m[0]);
    if (inCommentContext(cur, colIdx === -1 ? 0 : colIdx)) continue;
    if (hasEscape(lines, line)) continue;
    out.push({ file: rel, line, kind: "ternary", binding: m[1], snippet: cur.trim().slice(0, 160) });
  }
  return out;
}

/** Walk `text` starting at the `{` following a `catch (X)` header and return the index of the
 *  matching close `}`. Skips strings, template literals, and comments. Returns -1 on unbalanced. */
function findBlockClose(text: string, openBraceIdx: number): number {
  let balance = 1;
  let inStr: '"' | "'" | "`" | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = openBraceIdx + 1; i < text.length; i++) {
    const ch = text[i];
    const nch = text[i + 1];
    if (inLine) {
      if (ch === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && nch === "/") { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "/" && nch === "/") { inLine = true; i++; continue; }
    if (ch === "/" && nch === "*") { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch as '"' | "'" | "`"; continue; }
    if (ch === "{") { balance++; continue; }
    if (ch === "}") { balance--; if (balance === 0) return i; }
  }
  return -1;
}

/** Escape a string for use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCatchStringApplied(rel: string, text: string, lines: string[]): Finding[] {
  const out: Finding[] = [];
  const seenAsTernary = new Set<string>(); // `${file}:${line}` — dedupe against the ternary hit
  // Pre-collect ternary lines so we do not double-count on the same site.
  TERNARY.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TERNARY.exec(text))) {
    seenAsTernary.add(`${rel}:${lineOf(text, tm.index)}`);
  }
  CATCH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CATCH.exec(text))) {
    const binding = m[1];
    if (binding === "_") continue; // discarded — a `_` binding is idiomatic "I do not read it"
    // The `{` of the catch block: last char of the CATCH match.
    const openBraceIdx = m.index + m[0].length - 1;
    if (text[openBraceIdx] !== "{") continue;
    const closeBraceIdx = findBlockClose(text, openBraceIdx);
    if (closeBraceIdx === -1) continue;
    const bodyStart = openBraceIdx + 1;
    const body = text.slice(bodyStart, closeBraceIdx);
    const stringRe = new RegExp(`\\bString\\s*\\(\\s*${reEscape(binding)}\\s*\\)`, "g");
    let sm: RegExpExecArray | null;
    while ((sm = stringRe.exec(body))) {
      const absIdx = bodyStart + sm.index;
      const line = lineOf(text, absIdx);
      const key = `${rel}:${line}`;
      if (seenAsTernary.has(key)) continue; // the ternary's own String(X) — already flagged as ternary
      const cur = lines[line - 1] ?? "";
      const colIdx = cur.indexOf(sm[0]);
      if (inCommentContext(cur, colIdx === -1 ? 0 : colIdx)) continue;
      if (hasEscape(lines, line)) continue;
      out.push({ file: rel, line, kind: "catch-string", binding, snippet: cur.trim().slice(0, 160) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const findings: Finding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SKIP_FILES.has(rel)) continue;
    const text = readFileSync(abs, "utf8");
    if (!text.includes("instanceof Error") && !text.includes("String(")) continue; // quick reject
    const lines = text.split("\n");
    findings.push(...findTernaries(rel, text, lines));
    findings.push(...findCatchStringApplied(rel, text, lines));
  }

  if (summary) {
    console.log(
      `no-lossy-error-stringify — ${files.length} file(s) scanned, ${findings.length} lossy site(s) found`,
    );
    for (const f of findings) {
      console.log(`  [${f.kind}] ${f.file}:${f.line}  binding="${f.binding}"  ${f.snippet}`);
    }
  }

  if (findings.length > 0) {
    console.error(
      `\n❌ check-no-lossy-error-stringify — ${findings.length} lossy catch-site renderer(s) found:\n`,
    );
    for (const f of findings) {
      const kindLabel = f.kind === "ternary" ? "LOSSY TERNARY" : "BARE String(caught-binding)";
      console.error(`  • ${f.file}:${f.line}  [${kindLabel}]  binding="${f.binding}"`);
      console.error(`      ${f.snippet}`);
    }
    console.error(
      `\nlossless-error-diagnostics-no-object-object — a supabase-js PostgREST error is a PLAIN\n` +
      `object, not an Error, so \`X instanceof Error ? X.message : String(X)\` (and the narrower\n` +
      `bare \`String(caught-binding)\` inside a catch block) render it as \`[object Object]\` and\n` +
      `destroy the code/details/hint. Route this call through the shared renderer:\n` +
      `\n` +
      `  import { errText } from "@/lib/error-text";           // src/lib/**\n` +
      `  import { errText } from "../src/lib/error-text";      // scripts/builder-worker.ts\n` +
      `  ...\n` +
      `  } catch (e) {\n` +
      `    console.error(\`... : \${errText(e)}\`);\n` +
      `  }\n` +
      `\n` +
      `If the caught value is provably a string (a hand-thrown string literal, a rejected fetch\n` +
      `body already narrowed to string, etc.), add a same-line or line-above line-comment escape:\n` +
      `\n` +
      `  // lossy-error-ok: caught value is a string throw from foo()\n` +
      `  console.error(\`... : \${String(e)}\`);\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-no-lossy-error-stringify — ${files.length} file(s) scanned; 0 lossy catch-site renderer(s).`,
  );
}

main();
