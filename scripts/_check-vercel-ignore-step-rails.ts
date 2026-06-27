/**
 * Static-analysis check: the Vercel Ignored-Build-Step override builds `claude/*` ONLY.
 *
 * The Phase 3 safety rail of [[../docs/brain/goals/preview-test-promote-pipeline]] M1. The override
 * command in `src/lib/vercel-project.ts` (`CLAUDE_PREVIEW_IGNORE_COMMAND`) gates which refs Vercel
 * builds. The rail is that an incidental branch (no `claude/` prefix, not production) STILL skips
 * — so the override never silently re-enables every preview. This script asserts the contract is
 * preserved in the literal string:
 *
 *   1. `claude/` is the build discriminator (the M1 unlock — `claude/*` build branches build).
 *   2. `VERCEL_ENV` / `production` are referenced (the production deploy still builds).
 *   3. The else-branch is `exit 0` (the SKIP for incidental refs — Vercel's `exit 0` = skip).
 *   4. The `claude/` discriminator is anchored at the start of the ref (`^claude/`) so a feature
 *      branch with "claude" in its name doesn't accidentally satisfy the regex.
 *
 * Mirrors `_check-pm-md-reads.ts` / `_check-pm-sdk-compliance.ts` in shape: read-only, exits 1
 * on a violation with a human-readable diagnosis. Wire into `predeploy` to break CI red if the
 * rail is ever weakened by a code change.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = resolve(__dirname, "..", "src", "lib", "vercel-project.ts");

type Check = {
  name: string;
  pattern: RegExp;
  why: string;
};

const CHECKS: Check[] = [
  {
    name: "claude/ build discriminator",
    pattern: /grep\s+-q\s+'\^claude\//,
    why: "Without the `^claude/` anchor the override loses its `claude/*`-only contract.",
  },
  {
    name: "production env check",
    pattern: /\$VERCEL_ENV"?\s*=\s*production/,
    why: "Production deploys must always build — the rail keeps `$VERCEL_ENV = production` BUILDING.",
  },
  {
    name: "exit 0 else-branch (SKIP for incidental refs)",
    pattern: /else\s+exit\s+0\s*;/,
    why: "The else-branch is the safety rail: incidental refs (non-`claude/`, non-production) MUST skip (`exit 0`), or the override silently rebuilds every branch.",
  },
  {
    name: "exit 1 then-branch (BUILD for matching refs)",
    pattern: /then\s+exit\s+1\s*;/,
    why: "The then-branch must `exit 1` so Vercel BUILDS the matching ref (Vercel's Ignored-Build-Step inverts: `exit 1` = build, `exit 0` = skip).",
  },
];

function main() {
  let src: string;
  try {
    src = readFileSync(SRC, "utf8");
  } catch (e) {
    console.error(`❌ check-vercel-ignore-step-rails — could not read ${SRC}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // Match the backtick / single-quote / double-quote string literal assigned to the constant.
  // Backticks are the live shape; the alternation keeps the check robust to a quote-style refactor.
  const m = src.match(/export\s+const\s+CLAUDE_PREVIEW_IGNORE_COMMAND\s*[:\w<>\s,]*=\s*(`[^`]*`|'[^']*'|"[^"]*")\s*;/);
  if (!m) {
    console.error(
      `❌ check-vercel-ignore-step-rails — could not locate \`export const CLAUDE_PREVIEW_IGNORE_COMMAND = <string-literal>;\` in ${SRC}.\n` +
      `   The Phase 3 rail asserts properties of that exact constant; renaming it or splitting it across concatenations breaks the check.`,
    );
    process.exit(1);
  }
  const literal = m[1];

  const failed = CHECKS.filter((c) => !c.pattern.test(literal));
  if (failed.length) {
    console.error(`\n❌ check-vercel-ignore-step-rails — ${failed.length} rail(s) failed on CLAUDE_PREVIEW_IGNORE_COMMAND:\n`);
    for (const f of failed) {
      console.error(`  • ${f.name}`);
      console.error(`      pattern: ${f.pattern}`);
      console.error(`      why:     ${f.why}\n`);
    }
    console.error(`Override literal as found:\n  ${literal.trim()}\n`);
    console.error(
      `The override builds \`claude/*\` ONLY — it must NEVER widen to every preview. See\n` +
      `docs/brain/integrations/vercel.md § Ignored-Build-Step override and\n` +
      `docs/brain/libraries/vercel-project.md § Safety rails for the contract.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-vercel-ignore-step-rails — CLAUDE_PREVIEW_IGNORE_COMMAND preserves the \`claude/*\`-only contract ` +
    `(${CHECKS.length}/${CHECKS.length} rails).`,
  );
}

main();
