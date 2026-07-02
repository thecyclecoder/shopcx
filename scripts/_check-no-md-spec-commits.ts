/**
 * Static-analysis check: no code path commits `docs/brain/specs/*.md` to `main`, and no tracked
 * `docs/brain/specs/*.md` file reappears. Enforces the [[retire-md-spec-writers-db-is-sole-spec]]
 * invariant — the DB (`public.specs` + `public.spec_phases`) is the sole spec, so a per-spec
 * markdown committed to `main` is by definition an ORPHAN the build pipeline can't see.
 *
 * Two-direction guard:
 *   (a) FS: any tracked file under `docs/brain/specs/**.md` fails (the sweep left the directory
 *       empty). A future author surface that regresses to an .md commit shows up here.
 *   (b) CODE: any source under `src/` or `scripts/` that PUTs `docs/brain/specs/…` via the GitHub
 *       Contents API, or writes to a `docs/brain/specs/{slug}.md` path template, fails.
 *
 * Wired into `npm run check:no-md-spec-commits` + chained into `predeploy` so a regression
 * breaks CI red, not silently. Read-only; never mutates state.
 *
 * Mirrors the `_check-pm-md-reads.ts` / `_check-pm-sdk-compliance.ts` shape.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");

/** File-tree finding — a per-spec .md that shouldn't exist. */
interface OrphanMd { path: string }

/** Code finding — a source line that looks like a commit/PUT to docs/brain/specs/*.md. */
interface CodeViolation { file: string; line: number; pattern: string; snippet: string }

// ── (a) FS check: no tracked `docs/brain/specs/**.md` files ──────────────────

function listMdSpecs(): OrphanMd[] {
  const dir = join(REPO_ROOT, "docs", "brain", "specs");
  if (!existsSync(dir)) return []; // dir deleted entirely is fine
  const out: OrphanMd[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.endsWith(".md")) out.push({ path: relative(REPO_ROOT, p) });
    }
  };
  walk(dir);
  return out;
}

// ── (b) CODE check: no `docs/brain/specs/{slug}.md` PUT / write pattern ──────

/** Patterns that signal a spec-md commit/PUT. */
const CODE_PATTERNS: { id: string; re: RegExp }[] = [
  // A GitHub Contents API URL that names docs/brain/specs (any HTTP verb).
  { id: "contents-api-docs-brain-specs", re: /api\.github\.com\/repos\/[^"'`]*\/contents\/[^"'`]*docs\/brain\/specs/ },
  // A path template that concatenates a slug into docs/brain/specs/*.md (creator surface).
  { id: "path-template-slug-md", re: /docs\/brain\/specs\/\$\{[^}]+\}\.md/ },
];

/** Directories to scan for code violations. */
const SCAN_DIRS = ["src", "scripts"];

/**
 * Allow-list of (file, pattern-id) pairs that are INTENTIONAL — this check does NOT flag them. Keep
 * this list narrow; a real writer never belongs here. Extend only with a clear reason.
 *
 * Two categories qualify (both TRANSPORT paths — not committed to main):
 *   - The build-spec worktree scratch buffer. builder-worker.ts spec-chat writes a per-spec .md
 *     inside a THROWAWAY worktree the deterministic worker parses and DISCARDS (via
 *     `git worktree remove`). Never committed; a re-read of that same slug template inside the
 *     worktree lifetime is fine.
 *   - The prompt-string mentions inside builder-worker.ts that tell the agent to write the buffer
 *     (the strings themselves match the regex but they are instructions, not the write itself).
 *   - This check-script (it INSPECTS the pattern; its own regex includes the pattern by definition).
 *   - The harness in _harness-needs-attention-authors-db-row.ts (it asserts on the same URL fragment).
 */
const CODE_ALLOWLIST: { file: string; pattern: string; reason: string }[] = [
  { file: "scripts/builder-worker.ts", pattern: "path-template-slug-md", reason: "throwaway worktree scratch buffer for spec-chat (transport, discarded by git worktree remove) + agent-instruction prompts" },
  { file: "scripts/_check-no-md-spec-commits.ts", pattern: "contents-api-docs-brain-specs", reason: "this check-script's own detection regex" },
  { file: "scripts/_check-no-md-spec-commits.ts", pattern: "path-template-slug-md", reason: "this check-script's own detection regex" },
  { file: "scripts/_harness-needs-attention-authors-db-row.ts", pattern: "contents-api-docs-brain-specs", reason: "harness asserts no contents-PUT fires (matches the URL fragment on purpose)" },
];

function isAllowed(file: string, patternId: string): boolean {
  return CODE_ALLOWLIST.some((a) => a.file === file && a.pattern === patternId);
}

function scanCode(): CodeViolation[] {
  const out: CodeViolation[] = [];
  for (const rel of SCAN_DIRS) {
    const dir = join(REPO_ROOT, rel);
    if (!existsSync(dir)) continue;
    const stack: string[] = [dir];
    while (stack.length) {
      const d = stack.pop()!;
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        const s = statSync(p);
        if (s.isDirectory()) { stack.push(p); continue; }
        if (!/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry)) continue;
        const filerel = relative(REPO_ROOT, p);
        const src = readFileSync(p, "utf8");
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          for (const { id, re } of CODE_PATTERNS) {
            if (re.test(lines[i]) && !isAllowed(filerel, id)) {
              out.push({ file: filerel, line: i + 1, pattern: id, snippet: lines[i].trim().slice(0, 200) });
            }
          }
        }
      }
    }
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const orphans = listMdSpecs();
  const violations = scanCode();
  const bad = orphans.length + violations.length;

  if (orphans.length) {
    console.error(`\n❌ check-no-md-spec-commits — ${orphans.length} orphan docs/brain/specs/*.md file(s):`);
    for (const o of orphans) console.error(`  • ${o.path}`);
    console.error(
      `\nThe per-spec markdown was retired in retire-md-spec-writers-db-is-sole-spec —\n` +
      `the DB is the sole spec (public.specs + public.spec_phases). A committed .md file is an\n` +
      `orphan the build pipeline can't see. Delete it, or author the spec through authorSpecRowStructured.`,
    );
  }

  if (violations.length) {
    console.error(`\n❌ check-no-md-spec-commits — ${violations.length} code path(s) commit/PUT to docs/brain/specs:`);
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}  [${v.pattern}]`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\nRoute every spec-authoring surface through the authorSpecRowStructured chokepoint\n` +
      `(src/lib/author-spec.ts) — writes to public.specs + public.spec_phases directly. NEVER\n` +
      `PUT docs/brain/specs/*.md via the GitHub Contents API. If this match is a genuinely\n` +
      `transport path (a throwaway worktree scratch buffer or the harness itself), add the (file, pattern)\n` +
      `pair to CODE_ALLOWLIST in scripts/_check-no-md-spec-commits.ts with a written reason.\n`,
    );
  }

  if (bad) process.exit(1);

  console.log(
    `✓ check-no-md-spec-commits — 0 orphan .md file(s); 0 code path(s) commit to docs/brain/specs/*.md; ` +
    `${CODE_ALLOWLIST.length} allow-listed transport site(s).`,
  );
}

main();
