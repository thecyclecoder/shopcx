/**
 * Static-analysis check: NOTHING in `src/**` calls the Klaviyo API without
 * going through the retirement guard.
 *
 * Klaviyo's subscription was cancelled in August 2026 (klaviyo-sunset, Phase A).
 * Every remaining call site — the reviews client, the lead push, the five
 * Inngest sync/import functions — is guarded by `KLAVIYO_RETIRED` from
 * [[../src/lib/klaviyo-retired.ts]], which is the ONE chokepoint that makes the
 * retirement mechanical rather than a thing everyone has to remember.
 *
 * The failure mode this catches: someone adds a new `a.klaviyo.com` fetch (or
 * un-guards an existing one) and it merges green, quietly resuming traffic to a
 * vendor we have no contract with — and, in the lead-capture case, shipping
 * customer PII there. That is exactly what Phase A removed.
 *
 * **The rule:** any `src/**` file that names `a.klaviyo.com` outside a comment
 * MUST import from `@/lib/klaviyo-retired`. There is no allow-list — a genuinely
 * new Klaviyo integration would need a contract first, and then this check is
 * the right place to have the argument.
 *
 * Phase B deletes the guarded modules outright, at which point this check scans
 * clean with nothing to allow. Read-only; never mutates state. Mirrors the shape
 * of `scripts/_check-no-direct-appstle-mutations.ts`.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const KLAVIYO_URL_RE = /a\.klaviyo\.com/;
const GUARD_IMPORT_RE = /from\s+["'](?:@\/lib\/klaviyo-retired|\.\/klaviyo-retired|\.\.\/klaviyo-retired)["']/;
const SCAN_ROOT = "src";
const SCAN_EXTENSIONS = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * A URL match is prose when it appears inside a `//` line comment. Strips
 * `https://` first so the `//` in a real URL literal isn't mistaken for the
 * start of a comment.
 */
function isProseLine(line: string, index: number): boolean {
  const before = line.slice(0, index).replace(/https?:\/\//g, "");
  return before.includes("//") || before.trimStart().startsWith("*");
}

export type UnguardedKlaviyoCall = { file: string; line: number; text: string };

export function findUnguardedKlaviyoCalls(): UnguardedKlaviyoCall[] {
  const violations: UnguardedKlaviyoCall[] = [];
  for (const file of walk(SCAN_ROOT)) {
    const rel = file.replace(/^\.\//, "");
    if (rel.includes(".test.")) continue;

    const src = readFileSync(file, "utf8");
    if (!KLAVIYO_URL_RE.test(src)) continue;
    if (GUARD_IMPORT_RE.test(src)) continue;

    src.split("\n").forEach((line, i) => {
      const at = line.search(KLAVIYO_URL_RE);
      if (at === -1 || isProseLine(line, at)) return;
      violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) });
    });
  }
  return violations;
}

function main(): void {
  const violations = findUnguardedKlaviyoCalls();
  if (violations.length > 0) {
    console.error(`\n❌ check-no-klaviyo-calls — ${violations.length} unguarded Klaviyo call site(s):\n`);
    for (const v of violations) {
      console.error(`   ${v.file}:${v.line}`);
      console.error(`      ${v.text}`);
    }
    console.error(
      `\n   Klaviyo is a RETIRED vendor — the subscription was cancelled and no code` +
        `\n   path may reach its API. Any file naming a.klaviyo.com must import` +
        `\n   KLAVIYO_RETIRED from @/lib/klaviyo-retired and short-circuit on it.` +
        `\n   If you believe you need live Klaviyo data again, you need a contract` +
        `\n   before you need this check changed.\n`,
    );
    process.exit(1);
  }
  console.log("✅ check-no-klaviyo-calls — every Klaviyo call site is behind the retirement guard");
}

main();
