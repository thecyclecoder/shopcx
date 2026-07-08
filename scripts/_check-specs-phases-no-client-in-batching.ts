/**
 * Static-analysis check: NO client-side `.in("id", <array>)` / `.in("spec_slug", <array>)` batching
 * on the specs/phase read paths in `src/lib/specs-table.ts` or `src/lib/brain-roadmap.ts`.
 *
 * Phase 3 of docs/brain/specs/retire-residual-in-array-batching-to-server-side-rpcs.md — the guard
 * closes the door on the pattern the whole spec retired. The 2026-07-08 DB-overload incident
 * ([[../specs/list-specs-with-phases-rpc-retire-in-array-client-join]] precedent) traced to
 * `.in("<id-or-slug>", [large-array])` calls whose URL overflowed the ~16KB undici header cap
 * (UND_ERR_HEADERS_OVERFLOW), wedging getSpec/roadmap/claim-gate. Every id/slug read on these two
 * files is now supposed to route through a server-side RPC (list_specs_with_phases,
 * list_spec_phase_anomalies, roadmap_latest_needs_fix_reasons, roadmap_latest_build_signals,
 * roadmap_latest_status_transitions) — no id/slug array over the wire, ever.
 *
 * The guard fails on any `.in("id", …)` or `.in("spec_slug", …)` occurrence in the two hot-path
 * files, EXCEPT when the second argument is a genuinely-bounded LITERAL array (`[…]`) with no
 * identifiers — a small hardcoded set (e.g. `.in("id", ["a","b"])`) is fine, a variable
 * (`.in("id", specIds)`) or a `.slice(…)` batch is not. Comments (`//` line, `*` inside a block)
 * are ignored so doc-comments mentioning the retired pattern don't red the guard.
 *
 * Read-only; never mutates state. Runs in `predeploy`.
 *
 * Run:  npx tsx scripts/_check-specs-phases-no-client-in-batching.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const GUARDED_FILES = [
  "src/lib/specs-table.ts",
  "src/lib/brain-roadmap.ts",
] as const;
const GUARDED_COLUMNS = ["id", "spec_slug"] as const;

interface Finding {
  file: string;
  line: number;
  column: string;
  snippet: string;
  reason: string;
}

/**
 * Strip line + block comments so a doc-comment mentioning `.in("id", …)` (in the retired-pattern
 * explanation) doesn't red the guard. Preserves line count so reported line numbers are correct.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let inBlock = false;
  let inLine = false;
  let inString: '"' | "'" | "`" | null = null;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch; }
      else out += " ";
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; out += "  "; i += 2; continue; }
      if (ch === "\n") out += "\n";
      else out += " ";
      i++;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) { out += source[i + 1]; i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { inLine = true; out += "  "; i += 2; continue; }
    if (ch === "/" && next === "*") { inBlock = true; out += "  "; i += 2; continue; }
    out += ch;
    i++;
  }
  return out;
}

/**
 * A "genuinely-bounded literal set" — the second argument to `.in(...)` is a bracket-literal whose
 * elements are ALL string / number / boolean / null literals (no identifiers, no spreads, no calls,
 * no template interpolation). Any variable or expression → NOT bounded → guard fails.
 *
 * The scanner reads forward from the `[`, matches paired brackets/quotes, then splits on top-level
 * commas and checks each element against a literal-only regex.
 */
function isLiteralArrayArgument(source: string, argStart: number): boolean {
  if (source[argStart] !== "[") return false;
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let i = argStart;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; i++; continue; }
    if (ch === "[" || ch === "(" || ch === "{") { depth++; i++; continue; }
    if (ch === "]" || ch === ")" || ch === "}") {
      depth--;
      if (depth === 0 && ch === "]") { i++; break; }
      i++;
      continue;
    }
    i++;
  }
  const body = source.slice(argStart + 1, i - 1).trim();
  if (!body) return true; // `[]` — trivially bounded
  // Split on top-level commas.
  const parts: string[] = [];
  let start = 0;
  let d = 0;
  let q: '"' | "'" | "`" | null = null;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (q) { if (ch === "\\") { k++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
    if (ch === "[" || ch === "(" || ch === "{") d++;
    else if (ch === "]" || ch === ")" || ch === "}") d--;
    else if (ch === "," && d === 0) { parts.push(body.slice(start, k)); start = k + 1; }
  }
  parts.push(body.slice(start));
  const literalRe = /^\s*(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|-?\d+(?:\.\d+)?|true|false|null)\s*$/;
  return parts.every((p) => literalRe.test(p));
}

function scanFile(relPath: string): Finding[] {
  const abs = join(REPO_ROOT, relPath);
  const raw = readFileSync(abs, "utf8");
  const source = stripComments(raw);
  const findings: Finding[] = [];
  for (const col of GUARDED_COLUMNS) {
    const patterns = [
      new RegExp(`\\.in\\(\\s*"${col}"\\s*,\\s*`, "g"),
      new RegExp(`\\.in\\(\\s*'${col}'\\s*,\\s*`, "g"),
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const argStart = m.index + m[0].length;
        // If it's a literal array, permit it (spec: allow genuinely-bounded small literal sets).
        if (isLiteralArrayArgument(source, argStart)) continue;
        const line = source.slice(0, m.index).split("\n").length;
        const rawLines = raw.split("\n");
        const snippet = (rawLines[line - 1] ?? "").trim();
        findings.push({
          file: relPath,
          line,
          column: col,
          snippet,
          reason: `Client-side .in("${col}", <array>) batching is forbidden on this file — the 2026-07-08 DB-overload incident traced the ~16KB undici header cap (UND_ERR_HEADERS_OVERFLOW) to this pattern. Route the read through a server-side RPC (list_specs_with_phases, list_spec_phase_anomalies, roadmap_latest_needs_fix_reasons, roadmap_latest_build_signals, roadmap_latest_status_transitions) so no id/slug array crosses the wire.`,
        });
      }
    }
  }
  return findings;
}

function main() {
  const all: Finding[] = [];
  for (const f of GUARDED_FILES) all.push(...scanFile(f));

  if (all.length > 0) {
    console.error(`\n❌ check-specs-phases-no-client-in-batching — ${all.length} forbidden .in(<id|spec_slug>, <array>) call(s):\n`);
    for (const f of all) {
      console.error(`  • ${f.file}:${f.line}  .in("${f.column}", …)`);
      console.error(`    ${f.snippet}`);
    }
    console.error(
      `\nSpecs/phase read paths (${GUARDED_FILES.join(", ")}) may NOT ship a client-side id/slug\n` +
      `array over the wire — the URL overflows the ~16KB undici header cap once the workspace holds\n` +
      `a few hundred specs (2026-07-08 DB-overload incident + list-specs-with-phases-rpc precedent).\n` +
      `Route the read through a server-side RPC. Genuinely-bounded LITERAL sets are still allowed\n` +
      `(e.g. .in("id", ["a","b","c"]) — no variables), but a variable/slice/spread is not.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-specs-phases-no-client-in-batching — ${GUARDED_FILES.length} file(s) scanned; 0 client-side .in("id"|"spec_slug", <array>) call(s).`,
  );
}

main();
