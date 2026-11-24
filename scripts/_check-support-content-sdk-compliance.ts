/**
 * Static-analysis check: NO new raw WRITES to `public.knowledge_base` / `public.macros` outside the
 * support-content SDK (`src/lib/support-content.ts`).
 *
 * Both tables feed customer-facing AI through embeddings (`kb_chunks` for articles, `macros.embedding`
 * for macros). A raw content write that skips the re-embed leaves the AI quoting stale text — the
 * Nov 2026 "Mixed Berry Tabs have 40mg caffeine" error lived in 8 rows this way. The SDK couples every
 * content write with its re-embed.
 *
 * RATCHET, not a full chokepoint: reads are not policed, and the files that already wrote these tables
 * when the SDK landed (2026-11-24) are GRANDFATHERED below. A write in any OTHER file fails. When you
 * touch a grandfathered file, move its write into the SDK and delete it from the list — never add one.
 *
 * Detection: each `.from('knowledge_base'|'macros')` call, plus the rest of its statement (up to the
 * next `;`, max 800 chars), is scanned for `.update(` / `.insert(` / `.upsert(` / `.delete(`.
 *
 * Run:  npx tsx scripts/_check-support-content-sdk-compliance.ts   # exits 1 on any finding
 * Wired as `npm run check:support-content-sdk-compliance`, chained into `predeploy:static`.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");

const SDK_INTERNALS = new Set([
  "src/lib/support-content.ts",
  "scripts/_check-support-content-sdk-compliance.ts",
]);

/** Pre-SDK writers (2026-11-24). Shrink this list; never grow it. */
const GRANDFATHERED = new Set([
  "scripts/categorize-macros.ts",
  "scripts/cleanup-stale-policy-content.ts",
  "scripts/embed-macros.ts",
  "scripts/import-gorgias-macros.ts",
  "scripts/kb-crisis-article-swap.ts",
  "scripts/reimport-gorgias-macros.ts",
  "scripts/remap-kb-products.ts",
  "src/app/api/help/[slug]/feedback/route.ts",
  "src/app/api/widget/[workspaceId]/articles/[articleId]/route.ts",
  "src/app/api/workspaces/[id]/knowledge-base/[kbId]/route.ts",
  "src/app/api/workspaces/[id]/knowledge-base/route.ts",
  "src/app/api/workspaces/[id]/knowledge-gaps/route.ts",
  "src/app/api/workspaces/[id]/macros/[macroId]/route.ts",
  "src/app/api/workspaces/[id]/macros/route.ts",
  "src/app/help/[slug]/[articleSlug]/page.tsx",
  "src/lib/inngest/scrape-help-center.ts",
  "src/lib/product-intelligence/publish.ts",
]);

const FROM_RE = /\.from\(\s*["'`](knowledge_base|macros)["'`]\s*\)/g;
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
  table: string;
  op: string;
}

export function findRawWrites(src: string): Array<{ index: number; table: string; op: string }> {
  const hits: Array<{ index: number; table: string; op: string }> = [];
  for (const m of src.matchAll(FROM_RE)) {
    const start = (m.index ?? 0) + m[0].length;
    const semi = src.indexOf(";", start);
    const stmt = src.slice(start, Math.min(semi === -1 ? src.length : semi, start + 800));
    const w = stmt.match(WRITE_RE);
    if (w) hits.push({ index: m.index ?? 0, table: m[1], op: w[1] });
  }
  return hits;
}

function main() {
  const files = [...walkTs(join(REPO_ROOT, "src")), ...walkTs(join(REPO_ROOT, "scripts"))].sort();
  const findings: Finding[] = [];
  const staleGrandfathered = new Set(GRANDFATHERED);
  for (const full of files) {
    const rel = relative(REPO_ROOT, full).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue;
    const src = readFileSync(full, "utf8");
    const hits = findRawWrites(src);
    if (hits.length === 0) continue;
    if (GRANDFATHERED.has(rel)) {
      staleGrandfathered.delete(rel);
      continue;
    }
    for (const h of hits) {
      findings.push({ file: rel, line: src.slice(0, h.index).split("\n").length, table: h.table, op: h.op });
    }
  }

  for (const rel of staleGrandfathered) {
    console.log(`note: ${rel} is grandfathered but no longer writes knowledge_base/macros — remove it from GRANDFATHERED.`);
  }
  if (findings.length === 0) {
    console.log("✓ support-content SDK compliance: no new raw knowledge_base/macros writes.");
    return;
  }
  console.error(`✗ ${findings.length} raw knowledge_base/macros write(s) outside src/lib/support-content.ts:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  .from('${f.table}').${f.op}(…)`);
  console.error("Route content writes through updateKbArticleContent / updateMacroBody so the AI's embeddings stay in sync.");
  process.exit(1);
}

if (require.main === module) main();
