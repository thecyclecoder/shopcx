/**
 * Static-analysis check: NO raw `.from('product_customer_situations')` outside the SDK.
 *
 * `public.product_customer_situations` is the compliance-checked customer-situations dataset shared
 * by the AI shopping-agent MCP server and the PDP AEO work. Every read/write MUST go through the SDK
 * chokepoint `src/lib/customer-situations.ts` — `listSituations` / `getSituation` /
 * `upsertSituations`. The whole point of the chokepoint is the COMPLIANCE FILTER: shopper-facing
 * reads return only `compliance_ok=true` rows with non-compliant quotes stripped. A hand-rolled
 * `.from('product_customer_situations')` query bypasses that filter and could leak an incentivized
 * or disease-term quote to a shopper — exactly the health-claim exposure Phase 2's compliance module
 * exists to prevent.
 *
 * SCAN SCOPE: every `.ts`/`.tsx` under `src/` + `scripts/` (excluding node_modules / .next /
 * dotdirs). The ONLY file allowed to issue raw `.from('product_customer_situations')` is the SDK
 * itself. Mirrors scripts/_check-competitors-sdk-compliance.ts. Wired into
 * `npm run check:customer-situations-sdk-compliance` + chained into `predeploy`. Read-only.
 *
 * Run:  npx tsx scripts/_check-customer-situations-sdk-compliance.ts            # exits 1 on any finding
 *       npx tsx scripts/_check-customer-situations-sdk-compliance.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-customer-situations-sdk-compliance.ts. */
const REPO_ROOT = join(__dirname, "..");

/**
 * The sanctioned raw-access files. `src/lib/customer-situations.ts` IS the SDK. The compliance
 * script itself is excluded — its docstrings reference the `.from(...)` pattern in prose.
 */
const SDK_INTERNALS = new Set([
  "src/lib/customer-situations.ts",
  "scripts/_check-customer-situations-sdk-compliance.ts",
]);

/** Table under guard. */
const TABLE = "product_customer_situations";

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

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)`, "g");

/** Scan one file's text for raw `.from('product_customer_situations')` calls. */
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
      `customer-situations-SDK-compliance — ${files.length} file(s) scanned, ${findings.length} raw \`.from('${TABLE}')\` finding(s)`,
    );
    for (const f of findings) console.log(`  [VIOLATION] ${f.file}:${f.line}  ${f.snippet}`);
  }

  if (findings.length > 0) {
    console.error(
      `\n❌ check-customer-situations-sdk-compliance — ${findings.length} raw \`.from('${TABLE}')\` outside the SDK:\n`,
    );
    for (const f of findings) {
      console.error(`  • ${f.file}:${f.line}  →  ${f.snippet}`);
    }
    console.error(
      `\nRead/write access to \`public.${TABLE}\` goes through the SDK chokepoint\n` +
      `\`src/lib/customer-situations.ts\` — \`listSituations\` / \`getSituation\` / \`upsertSituations\`.\n` +
      `A hand-rolled query bypasses the compliance filter (compliant-only rows + non-compliant quotes\n` +
      `stripped) and could leak an incentivized or disease-term quote to a shopper. Retarget this call\n` +
      `to the SDK — see CLAUDE.md § Local conventions.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-customer-situations-sdk-compliance — ${files.length} file(s) scanned; 0 raw \`.from('${TABLE}')\` outside the SDK.`,
  );
}

main();
