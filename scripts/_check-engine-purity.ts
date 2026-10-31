/**
 * Static-analysis check: everything under `src/lib/engine/` stays PURE, so the
 * folder can lift verbatim into the shared ShopCX/ShopGrowth engine package.
 *
 * The engine takes data in and returns a verdict. It may not reach ShopCX
 * (`@/...` imports or a relative import that escapes the folder), a database,
 * the network, secrets (`process.env`), or the clock / randomness (callers pass
 * `now` in, so verdicts are deterministic and replayable in the side-by-side
 * run). Third-party packages are allow-listed: anything the engine imports
 * becomes a dependency of BOTH businesses.
 *
 * The failure mode this catches: a convenient `import { createAdminClient }`
 * or `Date.now()` slips into the engine, ShopCX keeps working, and the lift to
 * the shared package breaks (or worse, the app silently gets ShopCX coupling).
 *
 *   Run:    npx tsx scripts/_check-engine-purity.ts
 *   Wired:  `npm run check:engine-purity` → chained into `predeploy:static`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve, relative, sep } from "path";

const ENGINE_ROOT = "src/lib/engine";
/** Bare packages the engine may import. Adding one adds a dependency to both businesses. */
export const ALLOWED_PACKAGES = new Set<string>(["zipcodes"]);

const IMPORT_RE = /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[^\w$.])require\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[^\w$.])import\s*["']([^"']+)["']/g;

const FORBIDDEN_CALLS: Array<{ re: RegExp; why: string }> = [
  { re: /\bprocess\.env\b/, why: "reads secrets/config (process.env); pass values in" },
  { re: /(?<![\w$.])fetch\s*\(/, why: "network call (fetch); the caller loads data" },
  { re: /\bDate\.now\s*\(/, why: "reads the clock (Date.now); take `now` as a parameter" },
  { re: /\bnew\s+Date\s*\(\s*\)/, why: "reads the clock (new Date()); take `now` as a parameter" },
  { re: /\bMath\.random\s*\(/, why: "nondeterministic (Math.random); verdicts must replay identically" },
];

export type EngineImpurity = { file: string; line: number; reason: string; text: string };

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Strip `//` line comments and `/* *\/` blocks so prose never flags. Keeps line count. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (_m, p1: string) => p1);
}

/**
 * Pure scan of one engine file. `engineRoot` is the absolute engine folder, used to
 * decide whether a relative import escapes it.
 */
export function findEngineImpurities(file: string, src: string, engineRoot: string): EngineImpurity[] {
  const out: EngineImpurity[] = [];
  const code = stripComments(src);
  const lines = code.split("\n");
  const original = src.split("\n");
  lines.forEach((line, i) => {
    const text = (original[i] ?? "").trim().slice(0, 120);
    for (const m of line.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!spec) continue;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(resolve(file)), spec);
        const rel = relative(engineRoot, target);
        if (rel.startsWith("..") || rel.split(sep)[0] === "..") {
          out.push({ file, line: i + 1, reason: `relative import "${spec}" escapes src/lib/engine/`, text });
        }
      } else if (spec.startsWith("@/")) {
        out.push({ file, line: i + 1, reason: `imports ShopCX code ("${spec}")`, text });
      } else if (!ALLOWED_PACKAGES.has(packageName(spec))) {
        out.push({ file, line: i + 1, reason: `package "${packageName(spec)}" is not on the engine allow-list`, text });
      }
    }
    for (const { re, why } of FORBIDDEN_CALLS) {
      if (re.test(line)) out.push({ file, line: i + 1, reason: why, text });
    }
  });
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function main(): void {
  if (!existsSync(ENGINE_ROOT)) {
    console.error(`❌ check-engine-purity — ${ENGINE_ROOT} is missing`);
    process.exit(1);
  }
  const root = resolve(ENGINE_ROOT);
  const violations = walk(ENGINE_ROOT).flatMap((f) => findEngineImpurities(f, readFileSync(f, "utf8"), root));
  if (violations.length > 0) {
    console.error(`\n❌ check-engine-purity — ${violations.length} impurity(ies) in ${ENGINE_ROOT}:\n`);
    for (const v of violations) {
      console.error(`   ${v.file}:${v.line} — ${v.reason}`);
      console.error(`      ${v.text}`);
    }
    console.error(
      `\n   The engine is shared with ShopGrowth and must stay pure: data in, verdict out.` +
        `\n   Load data, read env/clock, and act on results in ShopCX wiring outside` +
        `\n   src/lib/engine/, and pass what the engine needs as arguments.\n`,
    );
    process.exit(1);
  }
  console.log("✅ check-engine-purity — src/lib/engine/ is pure");
}

if (require.main === module) main();
