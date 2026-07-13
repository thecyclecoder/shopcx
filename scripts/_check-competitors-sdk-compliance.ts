/**
 * Static-analysis check: NO raw `.from('competitors')` outside the competitor SDK.
 *
 * `public.competitors` is the DB-driven, supervisable competitor set — the foundation of the
 * Acquisition Research Engine (M1). Every read/write MUST go through `src/lib/competitors.ts` (the
 * SDK chokepoint) — `listCompetitors` / `getCompetitor` / `upsertCompetitor` /
 * `setCompetitorStatus` / `deleteCompetitor` / `listOrphanCompetitors` /
 * `deleteOrphanCompetitors` (+ `getCompetitorBrandsById` for the `runs_ads_for` self-FK
 * resolution). A raw `.from('competitors')` in a route/lib/script bypasses the SDK — it can pick
 * the wrong column name / miss the product-scope semantics and silently read as empty (a workspace
 * with 82 rows once read as 0 because a raw probe selected a non-existent `name` column).
 *
 * SCAN SCOPE: every `.ts`/`.tsx` under `src/` + `scripts/` (excluding node_modules / .next /
 * dotdirs). The ONLY file allowed to issue raw `.from('competitors')` is the SDK itself
 * (`src/lib/competitors.ts`) — it IS the sanctioned writer.
 *
 * Mirrors [[../scripts/_check-pm-sdk-compliance.ts]]. Wired into `npm run
 * check:competitors-sdk-compliance` + chained into `predeploy`. Read-only; never mutates.
 *
 * Run:  npx tsx scripts/_check-competitors-sdk-compliance.ts            # exits 1 on any finding
 *       npx tsx scripts/_check-competitors-sdk-compliance.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-competitors-sdk-compliance.ts. */
const REPO_ROOT = join(__dirname, "..");

/**
 * The sanctioned raw-access files. `src/lib/competitors.ts` IS the SDK.
 * The compliance script itself is excluded — its docstrings reference the `.from('competitors')`
 * pattern in prose, which the regex would flag on itself otherwise.
 */
const SDK_INTERNALS = new Set([
  "src/lib/competitors.ts",
  "scripts/_check-competitors-sdk-compliance.ts",
]);

/** Table under guard. */
const TABLE = "competitors";

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

/** Every file in scan scope (src/** + scripts/**), de-duped + sorted. */
function scanFiles(): string[] {
  const files = new Set<string>();
  for (const f of walkTs(join(REPO_ROOT, "src"))) files.add(f);
  for (const f of walkTs(join(REPO_ROOT, "scripts"))) files.add(f);
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Finding the raw accesses. A single-line `.from("competitors")` anchor is enough — the presence
 * of any such call outside the SDK is a violation whether it's a read or a write.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)`, "g");

/** Scan one file's text for raw `.from('competitors')` calls. Line/snippet-based; no verb classification. */
function findRawAccess(rel: string, text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  let m: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(text)) !== null) {
    const line = text.slice(0, m.index).split("\n").length; // 1-based
    out.push({ file: rel, line, snippet: lines[line - 1].trim().slice(0, 160) });
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
    if (SDK_INTERNALS.has(rel)) continue; // the SDK itself — sanctioned by definition
    const text = readFileSync(abs, "utf8");
    findings.push(...findRawAccess(rel, text));
  }

  if (summary) {
    console.log(
      `competitors-SDK-compliance — ${files.length} file(s) scanned, ${findings.length} raw \`.from('${TABLE}')\` finding(s)`,
    );
    for (const f of findings) console.log(`  [VIOLATION] ${f.file}:${f.line}  ${f.snippet}`);
  }

  if (findings.length > 0) {
    console.error(
      `\n❌ check-competitors-sdk-compliance — ${findings.length} raw \`.from('${TABLE}')\` outside the SDK:\n`,
    );
    for (const f of findings) {
      console.error(`  • ${f.file}:${f.line}  →  ${f.snippet}`);
    }
    console.error(
      `\nRead/write access to \`public.${TABLE}\` goes through the SDK chokepoint\n` +
      `\`src/lib/competitors.ts\` — \`listCompetitors\` / \`getCompetitor\` / \`upsertCompetitor\` /\n` +
      `\`setCompetitorStatus\` / \`deleteCompetitor\` / \`listOrphanCompetitors\` /\n` +
      `\`deleteOrphanCompetitors\` (+ \`getCompetitorBrandsById\` for the \`runs_ads_for\` self-FK).\n` +
      `A hand-rolled query gets the wrong column name or product scope and silently reads as empty\n` +
      `(a workspace with 82 rows once read as 0 because a raw probe selected a non-existent \`name\`\n` +
      `column). Retarget this call to the SDK — see CLAUDE.md § Local conventions.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-competitors-sdk-compliance — ${files.length} file(s) scanned; 0 raw \`.from('${TABLE}')\` outside the SDK.`,
  );
}

main();
