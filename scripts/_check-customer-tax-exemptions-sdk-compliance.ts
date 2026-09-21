/**
 * Static-analysis check: NO raw `.from('customer_tax_exemptions')` outside the
 * customer-tax-exemptions SDK.
 *
 * `public.customer_tax_exemptions` records whether we charge a buyer sales tax. Its shape has
 * gotchas — a partial UNIQUE on `(customer_id, jurisdiction_region) WHERE revoked_at IS NULL`,
 * an uppercased region, an OPTIONAL `expires_at` that MUST be treated as "no longer live" once
 * past — every one of which is easy to miss with a hand-rolled query. Worse, missing them fails
 * safe in the wrong direction: a resolver that forgets the expiry check keeps zeroing tax for a
 * customer whose certificate lapsed months ago.
 *
 * Every read/write MUST go through `src/lib/customer-tax-exemptions.ts` (the SDK chokepoint) —
 * `resolveCustomerTaxExemption` / `listCustomerTaxExemptions` / `recordCustomerTaxExemption` /
 * `revokeCustomerTaxExemption`. A raw `.from('customer_tax_exemptions')` in a route/lib/script
 * bypasses the SDK.
 *
 * SCAN SCOPE: every `.ts`/`.tsx` under `src/` + `scripts/` (excluding node_modules / .next /
 * dotdirs). The ONLY file allowed to issue raw `.from('customer_tax_exemptions')` is the SDK
 * itself (`src/lib/customer-tax-exemptions.ts`) and files on the `SANCTIONED_RAW_ACCESS`
 * allow-list below. Every entry on that list is debt — the goal is zero.
 *
 * Mirrors [[../scripts/_check-policies-sdk-compliance.ts]] (allow-list pattern). Wired into
 * `npm run check:customer-tax-exemptions-sdk-compliance` + chained into `predeploy:static`.
 * Read-only; never mutates.
 *
 * Run:  npx tsx scripts/_check-customer-tax-exemptions-sdk-compliance.ts
 *       npx tsx scripts/_check-customer-tax-exemptions-sdk-compliance.ts --summary
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-customer-tax-exemptions-sdk-compliance.ts. */
const REPO_ROOT = join(__dirname, "..");

/** Table under guard. */
const TABLE = "customer_tax_exemptions";

/**
 * The sanctioned raw-access files. `src/lib/customer-tax-exemptions.ts` IS the SDK. The
 * compliance script itself is excluded — its docstrings reference the `.from('customer_tax_
 * exemptions')` pattern in prose, which the regex would flag on itself otherwise.
 */
const SDK_INTERNALS = new Set([
  "src/lib/customer-tax-exemptions.ts",
  "scripts/_check-customer-tax-exemptions-sdk-compliance.ts",
]);

interface SanctionedEntry {
  file: string;
  reason: string;
}

/**
 * Sanctioned raw-access exceptions. Empty at Phase 1 launch — every runtime caller is expected
 * to reach the SDK from day one. Add an entry (with a written reason) only for a deliberate
 * one-off migration/probe that cannot go through the SDK; every entry is debt.
 */
const SANCTIONED_RAW_ACCESS: SanctionedEntry[] = [];

const SANCTIONED_FILES = new Set(SANCTIONED_RAW_ACCESS.map((e) => e.file));

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
 * Finding the raw accesses. A single-line `.from("customer_tax_exemptions")` anchor is enough —
 * the presence of any such call outside the SDK is a violation whether it's a read or a write.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)`, "g");

/** Scan one file's text for raw `.from('customer_tax_exemptions')` calls. */
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
  const sanctionedHits = new Set<string>();
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue; // the SDK itself — sanctioned by definition
    const text = readFileSync(abs, "utf8");
    const hits = findRawAccess(rel, text);
    if (!hits.length) continue;
    if (SANCTIONED_FILES.has(rel)) {
      sanctionedHits.add(rel);
      continue;
    }
    findings.push(...hits);
  }

  const stale = [...SANCTIONED_FILES].filter((f) => !sanctionedHits.has(f));

  if (summary) {
    console.log(
      `customer-tax-exemptions-SDK-compliance — ${files.length} file(s) scanned, ${findings.length} raw ` +
        `\`.from('${TABLE}')\` finding(s), ${sanctionedHits.size} allow-listed hit(s), ${stale.length} stale entry(s)`,
    );
    for (const f of findings) console.log(`  [VIOLATION] ${f.file}:${f.line}  ${f.snippet}`);
    for (const s of stale) console.log(`  [STALE ALLOWLIST] ${s}`);
  }

  if (findings.length > 0) {
    console.error(
      `\n❌ check-customer-tax-exemptions-sdk-compliance — ${findings.length} raw \`.from('${TABLE}')\` outside the SDK:\n`,
    );
    for (const f of findings) {
      console.error(`  • ${f.file}:${f.line}  →  ${f.snippet}`);
    }
    console.error(
      `\nRead/write access to \`public.${TABLE}\` goes through the SDK chokepoint\n` +
        `\`src/lib/customer-tax-exemptions.ts\` — \`resolveCustomerTaxExemption\` /\n` +
        `\`listCustomerTaxExemptions\` / \`recordCustomerTaxExemption\` / \`revokeCustomerTaxExemption\`.\n\n` +
        `A hand-rolled query gets the shape gotchas wrong (partial UNIQUE on (customer_id,\n` +
        `jurisdiction_region) WHERE revoked_at IS NULL; region uppercased; expires_at treated as\n` +
        `"no longer live" once past) and silently keeps zeroing tax for a customer whose\n` +
        `certificate lapsed months ago. Retarget this call to the SDK — see CLAUDE.md\n` +
        `§ Local conventions and [[docs/brain/tables/customer_tax_exemptions.md]].\n\n` +
        `If a genuine exception is unavoidable, add a written entry to \`SANCTIONED_RAW_ACCESS\`\n` +
        `in this file with the reason — every entry is debt and the goal is zero.\n`,
    );
    process.exit(1);
  }

  if (stale.length > 0) {
    console.error(
      `\n❌ check-customer-tax-exemptions-sdk-compliance — ${stale.length} stale entry(s) in SANCTIONED_RAW_ACCESS:\n`,
    );
    for (const s of stale) console.error(`  • ${s}  (no matching raw \`.from('${TABLE}')\` found)`);
    console.error(
      `\nRemove the stale entry(s) — the file no longer contains a raw access, so the sanction is dead code.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-customer-tax-exemptions-sdk-compliance — ${files.length} file(s) scanned; 0 raw \`.from('${TABLE}')\` ` +
      `outside the SDK (${sanctionedHits.size} allow-listed).`,
  );
}

main();
