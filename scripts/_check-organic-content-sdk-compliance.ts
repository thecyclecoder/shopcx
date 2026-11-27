/**
 * Static-analysis check: NO raw WRITES to `public.organic_content` outside the organic-content SDK
 * (`src/lib/social/organic-content.ts`).
 *
 * organic_content is the organic social library, separate from ads. The whole point of the chokepoint
 * (CLAUDE.md "raw .from with no SDK → STOP") is that the organic feed never silently reaches back into
 * the ads system, and that a wrong column can't write empty. Every write couples through the SDK's
 * insertOrganicContentDraft / setOrganicContentStatus so status + shape stay correct.
 *
 * Detection: each `.from('organic_content')` call, plus the rest of its statement (up to the next `;`,
 * max 800 chars), is scanned for `.update(` / `.insert(` / `.upsert(` / `.delete(`. Reads are not
 * policed.
 *
 * Run:  npx tsx scripts/_check-organic-content-sdk-compliance.ts   # exits 1 on any finding
 * Wired as `npm run check:organic-content-sdk-compliance`, chained into `predeploy:static`.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");

const SDK_INTERNALS = new Set([
  "src/lib/social/organic-content.ts",
  "scripts/_check-organic-content-sdk-compliance.ts",
]);

const FROM_RE = /\.from\(\s*["'`](organic_content)["'`]\s*\)/g;
const WRITE_RE = /\.(update|insert|upsert|delete)\(/;

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  op: string;
}

export function findRawWrites(src: string): Array<{ index: number; op: string }> {
  const hits: Array<{ index: number; op: string }> = [];
  for (const m of src.matchAll(FROM_RE)) {
    const start = (m.index ?? 0) + m[0].length;
    const semi = src.indexOf(";", start);
    const stmt = src.slice(start, Math.min(semi === -1 ? src.length : semi, start + 800));
    const w = stmt.match(WRITE_RE);
    if (w) hits.push({ index: m.index ?? 0, op: w[1] });
  }
  return hits;
}

function main() {
  const files = [...walkTs(join(REPO_ROOT, "src")), ...walkTs(join(REPO_ROOT, "scripts"))].sort();
  const findings: Finding[] = [];
  for (const full of files) {
    const rel = relative(REPO_ROOT, full).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue;
    const src = readFileSync(full, "utf8");
    for (const h of findRawWrites(src)) {
      findings.push({ file: rel, line: src.slice(0, h.index).split("\n").length, op: h.op });
    }
  }

  if (findings.length === 0) {
    console.log("✓ organic-content SDK compliance: no raw organic_content writes outside the SDK.");
    return;
  }
  console.error(`✗ ${findings.length} raw organic_content write(s) outside src/lib/social/organic-content.ts:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  .from('organic_content').${f.op}(…)`);
  console.error("Route writes through insertOrganicContentDraft / setOrganicContentStatus.");
  process.exit(1);
}

if (require.main === module) main();
