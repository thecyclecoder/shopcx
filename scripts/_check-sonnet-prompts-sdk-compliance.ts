/**
 * Static-analysis check: NO raw `sonnet_prompts` WRITE outside the sonnet-prompts SDK.
 *
 * Phase 1 of docs/brain/specs/sonnet-prompts-sdk-for-review-agent-db-access.md. The single sanctioned
 * WRITE surface for `public.sonnet_prompts` is `src/lib/sonnet-prompts-table.ts` (`proposePrompt` /
 * `applyReviewDecision` / `archiveSupersededPrompt` / `applyManualOverride`). A raw
 * `.from('sonnet_prompts').insert(…)` / `.update(…)` / `.upsert(…)` / `.delete(…)` in agent code
 * BYPASSES the SDK — it can drift by writing four of the five auto_decision columns and skipping
 * the compare-and-set that keeps review state consistent. This guard seals that class.
 *
 * SCAN SCOPE: `scripts/builder-worker.ts` + every `.ts`/`.tsx` under `src/lib` + `src/app`, EXCEPT
 * the SDK internals themselves (`src/lib/sonnet-prompts-table.ts`) — that IS the sanctioned raw
 * writer. The `scripts/**` one-off ops (meta-dm-*, insert-prompt-*, cleanup-*, audit-*, etc.) are
 * archival — routing them through the SDK is churn without a safety win, so they stay out of scope.
 *
 * Read verbs are OUT of scope: the SDK exposes `getProposal` + `listProposed`, but callers that
 * only read via a projection are free to keep a raw `.select(…)` chain — the guard is write-only
 * (mirrors `_check-pm-sdk-compliance.ts` / `_check-ticket-analyses-sdk-compliance.ts`).
 *
 * Any raw sonnet_prompts WRITE found outside the SDK that is NOT on the explicit
 * `SANCTIONED_RAW_WRITES` allow-list breaks CI red. Read-only; never mutates state.
 *
 * Run:  npx tsx scripts/_check-sonnet-prompts-sdk-compliance.ts            # exits 1 on any unexpected violation
 *       npx tsx scripts/_check-sonnet-prompts-sdk-compliance.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-sonnet-prompts-sdk-compliance.ts. */
const REPO_ROOT = join(__dirname, "..");

const TABLE = "sonnet_prompts" as const;

/** The write verbs that mutate the table (reads — select — are out of scope). */
const WRITE_VERBS = ["update", "insert", "upsert", "delete"] as const;

/** The SDK internals — the ONLY file allowed to issue raw sonnet_prompts writes (it IS the writer). */
const SDK_INTERNALS = new Set(["src/lib/sonnet-prompts-table.ts"]);

/**
 * Sanctioned raw-write exceptions: (file, fn, reason) entries. Each is a deliberate raw write that
 * is NOT routed through the SDK, with a written justification. Keep this list minimal — every
 * entry is debt. A finding is allowed iff (file, fn) matches an entry here.
 */
interface SanctionedEntry {
  file: string;
  fn: string;
  reason: string;
}

const SANCTIONED_RAW_WRITES: SanctionedEntry[] = [
  {
    file: "src/app/api/workspaces/[id]/sonnet-prompts/route.ts",
    fn: "POST",
    reason:
      "Admin CRUD lane. The workspace admin authors an arbitrary prompt row from Settings → AI → " +
      "Prompts; the write is not a review-state transition (no auto_decision touched), so it stays " +
      "on the plain insert. When the admin CRUD grows a decision-shaped mutation, promote it to " +
      "the SDK and drop this entry.",
  },
  {
    file: "src/app/api/workspaces/[id]/sonnet-prompts/route.ts",
    fn: "PATCH",
    reason:
      "Admin CRUD lane — arbitrary body-driven update of an admin-owned prompt row. Not a review " +
      "decision (the /override route owns that, routed through applyManualOverride). Same debt as " +
      "the POST entry above.",
  },
  {
    file: "src/app/api/workspaces/[id]/sonnet-prompts/route.ts",
    fn: "DELETE",
    reason:
      "Admin CRUD lane — hard delete of an admin-owned prompt row. Distinct from the supersede " +
      "archive path (`archiveSupersededPrompt` preserves the row); an admin explicitly asked for a " +
      "delete. Same debt as the POST entry above.",
  },
  {
    file: "src/app/api/workspaces/[id]/daily-analysis-reports/route.ts",
    // enclosingFn misreads the site as `gIds` (the nearest `const gIds = ...` binding above). The
    // actual site is inside POST — the regen cleanup path. Sanction under the heuristic's tag so
    // the entry matches without brittle enclosingFn rewrites.
    fn: "gIds",
    reason:
      "Regenerate cleanup (inside POST) — deletes proposed prompts left behind by a prior report " +
      "before drafting a fresh one. Not a review decision (proposed → nowhere). If regeneration " +
      "ever needs to preserve state, promote to an SDK writer.",
  },
];

/* ------------------------------------------------------------------------------------------------
 * Scope resolution.
 * --------------------------------------------------------------------------------------------- */

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

function scanFiles(): string[] {
  const files = new Set<string>();
  for (const f of walkTs(join(REPO_ROOT, "src/lib"))) files.add(f);
  for (const f of walkTs(join(REPO_ROOT, "src/app"))) files.add(f);
  const worker = join(REPO_ROOT, "scripts/builder-worker.ts");
  if (existsSync(worker)) files.add(worker);
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Finding the raw writes.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  verb: (typeof WRITE_VERBS)[number];
  fn: string;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`](${TABLE})["'\`]\\s*\\)`, "g");

function enclosingFn(lines: string[], idx: number): string {
  const decl =
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(|([A-Za-z0-9_]+)\s*\([^)]*\)\s*[:{]/;
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(decl);
    if (m) {
      const name = m[1] || m[2] || m[3];
      if (name && !["if", "for", "while", "switch", "catch", "return"].includes(name)) return name;
    }
  }
  return "<module>";
}

function findRawWrites(rel: string, text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  let m: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const cleaned = after.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
    const verbMatch = cleaned.match(/^\.\s*([A-Za-z]+)\s*\(/);
    if (!verbMatch) continue;
    const verb = verbMatch[1] as (typeof WRITE_VERBS)[number];
    if (!(WRITE_VERBS as readonly string[]).includes(verb)) continue;
    const line = text.slice(0, m.index).split("\n").length; // 1-based
    out.push({
      file: rel,
      line,
      verb,
      fn: enclosingFn(lines, line - 1),
      snippet: lines[line - 1].trim().slice(0, 160),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function isSanctioned(f: Finding): boolean {
  return SANCTIONED_RAW_WRITES.some((s) => s.file === f.file && s.fn === f.fn);
}

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const all: Finding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (SDK_INTERNALS.has(rel)) continue; // the SDK writer — sanctioned by definition
    all.push(...findRawWrites(rel, readFileSync(abs, "utf8")));
  }

  const violations = all.filter((f) => !isSanctioned(f));
  const allowed = all.filter(isSanctioned);

  if (summary) {
    console.log(`sonnet-prompts-SDK-compliance — ${files.length} file(s) scanned, ${all.length} raw ${TABLE}-write(s) found`);
    for (const f of all) {
      const tag = isSanctioned(f) ? "ALLOWED" : "VIOLATION";
      console.log(`  [${tag}] ${f.file}:${f.line}  ${f.fn}  .from('${TABLE}').${f.verb}()  ${f.snippet}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ check-sonnet-prompts-sdk-compliance — ${violations.length} raw ${TABLE}-write(s) outside the SDK:\n`);
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}  in ${v.fn}  →  .from('${TABLE}').${v.verb}()`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\n${TABLE} WRITES go through the SDK: \`src/lib/sonnet-prompts-table.ts\`.\n` +
      `Use the narrow writer for the mutation: proposePrompt (fresh proposal from any proposer) /\n` +
      `applyReviewDecision (auto-review verdict — status + all five auto_decision columns) /\n` +
      `archiveSupersededPrompt (supersede-target archive on the OLD row) / applyManualOverride\n` +
      `(human accept/reject/revert from /api/sonnet-prompts/[id]/override). If a raw write is\n` +
      `genuinely unavoidable, add the (file, fn, reason) entry to SANCTIONED_RAW_WRITES in this\n` +
      `script with a written reason.\n`,
    );
    process.exit(1);
  }

  const hit = new Set(allowed.map((f) => `${f.file}::${f.fn}`));
  const stale = SANCTIONED_RAW_WRITES.filter((s) => !hit.has(`${s.file}::${s.fn}`));
  if (stale.length) {
    console.warn(`⚠ check-sonnet-prompts-sdk-compliance — ${stale.length} stale allow-list entry/entries:`);
    for (const s of stale) console.warn(`  • ${s.file}::${s.fn} — ${s.reason}`);
    console.warn(`Remove from SANCTIONED_RAW_WRITES — the raw write it sanctioned is gone.`);
  }

  console.log(
    `✓ check-sonnet-prompts-sdk-compliance — ${files.length} file(s) scanned; ` +
    `${allowed.length} sanctioned raw ${TABLE}-write(s) (allow-listed); 0 unexpected.`,
  );
}

main();
