/**
 * Static-analysis check: NO inline `supabase.auth.getUser()` in
 * `src/app/api/**\/route.ts`. Every API-route handler must go through the
 * shared `getAuthedUser()` helper in `src/lib/supabase/server.ts` (tag
 * `db-load-route-auth-helper`), which verifies the JWT locally against the
 * cached JWKS — zero auth-table reads per request.
 *
 * Phase 3 of docs/brain/specs/db-load-route-auth-getclaims-codemod.md. The
 * codemod in Phase 2 swapped all 528 route handlers off the inline
 * `createClient() + supabase.auth.getUser()` pattern; without this guard the
 * win backslides the moment a new route is added with the copy-pasted old
 * pattern. Mirrors the shape of `_check-personas-no-duplicate-keys.ts` /
 * `_check-pm-md-reads.ts` — a hard rail chained into `predeploy`, not just
 * a convention.
 *
 * Read-only; never mutates state.
 *
 * Run:  npx tsx scripts/_check-route-auth-helper.ts
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");
const ROUTES_ROOT = join(REPO_ROOT, "src/app/api");

// Any occurrence of `.auth.getUser(` in a route file, once we've stripped
// // and /* … */ comments, is a violation. `.auth.getUser(` is precise
// enough to catch both `supabase.auth.getUser(...)` and the `auth.auth.getUser(...)`
// alias without false-hitting library imports.
const INLINE_PATTERN = /\.auth\.getUser\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walk(abs));
    } else if (name === "route.ts" || name === "route.tsx") {
      out.push(abs);
    }
  }
  return out;
}

// Strip // line comments and /* … */ block comments so a docstring reference
// to the old pattern (e.g. src/app/api/dashboard/sidebar-counts/route.ts's
// header comment) doesn't red the guard. We do NOT try to be a full JS/TS
// parser — this is a coarse strip that's sufficient for TSC-clean source.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === "\n") out += ch;
      i++;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        out += ch;
        if (i + 1 < src.length) out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(abs: string): Violation[] {
  const src = readFileSync(abs, "utf8");
  const stripped = stripComments(src);
  const violations: Violation[] = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (INLINE_PATTERN.test(lines[i])) {
      violations.push({
        file: relative(REPO_ROOT, abs),
        line: i + 1,
        snippet: lines[i].trim(),
      });
    }
  }
  return violations;
}

function main() {
  const files = walk(ROUTES_ROOT);
  const violations: Violation[] = [];
  for (const abs of files) {
    violations.push(...scanFile(abs));
  }

  if (violations.length > 0) {
    console.error(
      `\n❌ check-route-auth-helper — ${violations.length} inline auth.getUser() call(s) in src/app/api route handler(s):\n`,
    );
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\nAPI routes must use the shared getAuthedUser() helper from` +
        ` \`@/lib/supabase/server\` (tag \`db-load-route-auth-helper\`), not the\n` +
        `inline \`createClient() + supabase.auth.getUser()\` pattern. getAuthedUser()\n` +
        `verifies the JWT locally against the cached JWKS with zero auth-table reads;\n` +
        `the inline getUser() is a 5-table auth fan-out per request. Swap:\n\n` +
        `  const supabase = await createClient();\n` +
        `  const { data: { user } } = await supabase.auth.getUser();\n\n` +
        `for:\n\n` +
        `  const { user } = await getAuthedUser();\n\n` +
        `See docs/brain/specs/db-load-route-auth-getclaims-codemod.md.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-route-auth-helper — ${files.length} route handler(s) scanned; 0 inline auth.getUser() calls.`,
  );
}

main();
