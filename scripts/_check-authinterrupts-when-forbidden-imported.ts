/**
 * Static-analysis check: when ANY `src/` file imports `forbidden` from `next/navigation`,
 * `next.config.ts` MUST enable `experimental.authInterrupts` — otherwise the call throws
 * at runtime ("forbidden() is not enabled") and the route 500s instead of returning a 403.
 *
 * The originating incident (signature `vercel:68f6fc9180f7730f`, phase 1 of the
 * "storefront-blueprint-forbidden-auth-interrupts" spec) was exactly this: the storefront
 * PDP gate at `src/app/(storefront)/store/[workspace]/[slug]/page.tsx` calls `forbidden()`
 * to block non-owners on preview / not-yet-serving landers, but the app-level Next.js
 * config was missing `experimental.authInterrupts: true`, so every non-owner hit 500'd
 * instead of getting the intended 403.
 *
 * This guard prevents a future edit from dropping the flag while `forbidden()` callers
 * still exist — a config regression that tsc can't catch (both states type-check).
 *
 * Read-only; runs in `predeploy` alongside the other `check:*` guards.
 *
 * Run:  npx tsx scripts/_check-authinterrupts-when-forbidden-imported.ts
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");
const SRC_DIR = join(REPO_ROOT, "src");
const NEXT_CONFIG = join(REPO_ROOT, "next.config.ts");

const IMPORT_RE = /import\s*\{[^}]*\bforbidden\b[^}]*\}\s*from\s*["']next\/navigation["']/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

function findForbiddenImporters(): string[] {
  const files: string[] = [];
  walk(SRC_DIR, files);
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (IMPORT_RE.test(src)) hits.push(relative(REPO_ROOT, f));
  }
  return hits;
}

function nextConfigEnablesAuthInterrupts(): boolean {
  const src = readFileSync(NEXT_CONFIG, "utf8");
  // Match `experimental: { ... authInterrupts: true ... }` — permissive across
  // formatting (multi-line, other keys before/after, trailing commas).
  const experimentalBlockRe = /experimental\s*:\s*\{([\s\S]*?)\}/;
  const m = experimentalBlockRe.exec(src);
  if (!m) return false;
  return /\bauthInterrupts\s*:\s*true\b/.test(m[1]);
}

function main(): void {
  const importers = findForbiddenImporters();
  if (importers.length === 0) {
    // Nothing imports forbidden() — flag is optional, guard is a no-op.
    console.log(
      "check:authinterrupts-when-forbidden-imported: no src/ file imports forbidden() from next/navigation — nothing to enforce.",
    );
    return;
  }
  const enabled = nextConfigEnablesAuthInterrupts();
  if (!enabled) {
    console.error(
      `check:authinterrupts-when-forbidden-imported FAILED: ${importers.length} src/ file(s) import forbidden() from next/navigation but next.config.ts does NOT set experimental.authInterrupts=true.`,
    );
    console.error(
      "Without the flag, forbidden() throws a runtime error ('forbidden() is not enabled') and the route 500s instead of returning a 403.",
    );
    console.error("Importers:");
    for (const f of importers) console.error(`  - ${f}`);
    console.error(
      "\nFix: add `experimental: { authInterrupts: true }` to next.config.ts (preserve existing keys).",
    );
    process.exit(1);
  }
  console.log(
    `check:authinterrupts-when-forbidden-imported OK: ${importers.length} forbidden() importer(s) + experimental.authInterrupts=true in next.config.ts.`,
  );
}

main();
