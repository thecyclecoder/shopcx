/**
 * Static-analysis check: NO NEW autonomous caller of the RETIRED markdown spec-author path.
 *
 * retire-md-spec-writers-db-is-sole-spec Phase 4 (2026-07) — every autonomous spec-writer lane
 * (repair · coverage-register · brain-roadmap · platform-director · spec-review-on-mutate) now
 * authors via `authorSpecRowStructured` / `submitSpec` (the STRUCTURED chokepoint). The retired
 * markdown chokepoint — `authorSpecRowFromMarkdown` (src/lib/author-spec.ts) + its
 * `scripts/builder-worker.ts` wrapper `markNewSpecInReview` — must not sprout NEW autonomous
 * callers, because a prose-only Verification block parses to `exec_kind='needs_human'` and the
 * every-writer-authors-machine-runnable-verifications gate rejects it, parking the fix-spec at
 * the CEO inbox (the exact failing state this whole spec exists to kill).
 *
 * SCAN SCOPE: `scripts/builder-worker.ts` + every `.ts`/`.tsx` under `src/lib`, EXCEPT:
 *   - the DEFINITION sites themselves (`src/lib/author-spec.ts` for authorSpecRowFromMarkdown;
 *     the internal call inside `markNewSpecInReview`'s body at `scripts/builder-worker.ts`)
 *   - test files (`*.test.ts` / `*.spec.ts`)
 *
 * MATCH KEY: each finding carries a distinctive `tag` extracted from the call arguments — the
 * `actor` positional arg (for `markNewSpecInReview`, always a bare string literal) or
 * `opts.intendedStatusSetBy` (for `authorSpecRowFromMarkdown`). The tag is the STABLE identity
 * of the calling lane across small line-number drifts, so the allow-list stays valid on
 * legitimate refactors without hand-editing line numbers. A call whose (file, identifier, tag)
 * is on `SANCTIONED_MARKDOWN_CALLERS` is Phase-4 debt (a legacy lane awaiting its own
 * conversion spec); anything else fails CI red.
 *
 * Read-only; never mutates state. Wired into `npm run check:no-markdown-spec-authoring` +
 * chained into `predeploy` (alongside `check:pm-sdk-compliance` etc). Mirrors the shape of
 * `_check-pm-sdk-compliance.ts`.
 *
 * Run:  npx tsx scripts/_check-no-markdown-spec-authoring.ts             # exits 1 on any unexpected violation
 *       npx tsx scripts/_check-no-markdown-spec-authoring.ts --summary   # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-no-markdown-spec-authoring.ts. */
const REPO_ROOT = join(__dirname, "..");

/** The two retired markdown-author identifiers a new autonomous lane must not call. */
const MARKDOWN_AUTHOR_IDENTIFIERS = ["markNewSpecInReview", "authorSpecRowFromMarkdown"] as const;
type MarkdownAuthorIdentifier = (typeof MARKDOWN_AUTHOR_IDENTIFIERS)[number];

/** Files that DEFINE the retired identifiers — never scanned. */
const DEF_SITE_FILES = new Set<string>([
  "src/lib/author-spec.ts", // defines authorSpecRowFromMarkdown
]);

/** Sanctioned pre-Phase-4 callers. Each entry (file, identifier, tag, reason) is Phase-4 debt —
 *  a legacy lane that still funnels a markdown body through the retired chokepoint. A follow-up
 *  spec will move each onto `authorSpecRowStructured`; until then, this allow-list preserves the
 *  status quo without letting a NEW autonomous lane silently regress the invariant.
 *
 *  `tag` = the actor label the caller passes to the retired chokepoint (a string literal like
 *  `"db_health"` / `"director:platform"` / `"security-agent"`). It is the stable lane identity
 *  across small line-number drifts, so a legitimate refactor of the caller does not invalidate
 *  the allow-list. */
interface SanctionedMarkdownCaller {
  file: string;
  identifier: MarkdownAuthorIdentifier;
  tag: string;
  reason: string;
}

const SANCTIONED_MARKDOWN_CALLERS: SanctionedMarkdownCaller[] = [
  // ── scripts/builder-worker.ts pre-Phase-4 lanes ──────────────────────────────
  // Every entry below funnels an LLM-authored markdown body through the retired chokepoint. A
  // follow-up per-lane conversion spec will move each onto authorSpecRowStructured (mirroring the
  // repair-agent lane's Phase-2 switch, which now uses `buildRepairSpecInput`, and the
  // platform-director lane's Phase-3 switch, which uses `buildStructuredSpecInputFromMarkdown`).
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "db_health",
    reason:
      "db_health lane — the box's Sonnet-authored fix-spec markdown for a db-health finding. Pre-Phase-4 " +
      "debt; a follow-up spec converts to authorSpecRowStructured with a typed grep check on the fix's " +
      "target column.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "director:platform",
    reason:
      "director:platform lane — Ada's groom/bounce-back split verdicts carry per-split markdown bodies " +
      "(groomed_split, groomed_split via author_followup_spec, bounce-back split). Pre-Phase-4 debt; a " +
      "follow-up spec converts each split's LLM output into a structured spec input authored via " +
      "authorSpecRowStructured. NB: platform-director's applyDirectorAuthorFollowup already moved to the " +
      "structured door in Phase 3 (buildStructuredSpecInputFromMarkdown); these lanes are different sites.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "spec-chat",
    reason:
      "spec-chat lane — the founder chats with a spec, the LLM emits a re-authored markdown body, and " +
      "the lane persists it. Pre-Phase-4 debt; a follow-up spec routes the chat re-author through the " +
      "structured chokepoint (the chat LLM emits phases[] + typed checks[]).",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "authorSpecRowFromMarkdown",
    tag: "spec-chat",
    reason:
      "spec-chat lane's fallback author — same LLM output, direct call to the markdown chokepoint. " +
      "Same conversion path as the other spec-chat entry.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "migration-fix",
    reason:
      "migration-fix lane — Cole's code-gap fix spec (the human-approvable proposal that fixes the " +
      "gap the mechanical auto-heal punts). Pre-Phase-4 debt; a follow-up spec authors via " +
      "authorSpecRowStructured with a typed check asserting the fix target file / migration id.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "developer-message-center",
    reason:
      "developer-message-center lane — the box's response to a developer message center thread " +
      "authors a spec. Pre-Phase-4 debt; a follow-up spec routes through the structured chokepoint.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "director-coach",
    reason:
      "director-coach lane — the founder's director-coaching thread produces spec re-authors. " +
      "Pre-Phase-4 debt; a follow-up spec routes through the structured chokepoint.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "authorSpecRowFromMarkdown",
    tag: "director:",
    reason:
      "director-coach lane's alternate author path — the LLM output rides directly to the markdown " +
      "chokepoint with the actor stamped `director:{fn}`. Same conversion path as the other " +
      "director-coach entry.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "authorSpecRowFromMarkdown",
    tag: "repair-agent",
    reason:
      "repair-agent signature-append — NOT a new-spec author. This helper (appendSignatureToSpec) " +
      "appends a `**Repair-signature:**` line to an ALREADY-authored repair spec and re-authors it. " +
      "Retiring markdown re-author across the signature-append path requires a specs-table " +
      "serialize + re-parse round-trip; a follow-up spec will move it to the structured door.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "regression-agent",
    reason:
      "regression-agent lane — the box's authored regression-fix markdown for a shipped-spec regression. " +
      "Pre-Phase-4 debt; a follow-up spec authors via authorSpecRowStructured with a typed check on the " +
      "regressed verification bullet's spec_phase_checks row.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "security-agent",
    reason:
      "security-agent lane's dep-watch — the box's authored security fix-spec markdown. Pre-Phase-4 " +
      "debt; a follow-up spec authors via authorSpecRowStructured with a typed grep check on the " +
      "security-agent's implicated file / dep signature.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "authorSpecRowFromMarkdown",
    tag: "security-agent",
    reason:
      "security-agent lane's dep-watch fallback author — same LLM output, direct call to the markdown " +
      "chokepoint. Same conversion path as the other security-agent entry.",
  },
  {
    file: "scripts/builder-worker.ts",
    identifier: "markNewSpecInReview",
    tag: "storefront-optimizer",
    reason:
      "storefront-optimizer lane — the growth optimizer's build-or-request markdown spec for a " +
      "storefront surface. Pre-Phase-4 debt; a follow-up spec authors via authorSpecRowStructured " +
      "with a typed check on the surface's product_id / lander_type / audience.",
  },
];

/* ------------------------------------------------------------------------------------------------
 * Scope resolution — mirrors _check-pm-sdk-compliance.
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

/** Absolute paths of every file in scan scope (src/lib/** + builder-worker), de-duped + sorted.
 *  Test files are excluded — they may exercise the retired chokepoint on purpose. */
function scanFiles(): string[] {
  const files = new Set<string>();
  for (const f of walkTs(join(REPO_ROOT, "src/lib"))) {
    if (f.endsWith(".test.ts") || f.endsWith(".spec.ts") || f.endsWith(".test.tsx") || f.endsWith(".spec.tsx")) continue;
    files.add(f);
  }
  const worker = join(REPO_ROOT, "scripts/builder-worker.ts");
  if (existsSync(worker)) files.add(worker);
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Finding raw calls + tag extraction.
 * --------------------------------------------------------------------------------------------- */

interface Finding {
  file: string;
  line: number;
  identifier: MarkdownAuthorIdentifier;
  tag: string; // extracted actor label — the stable lane identity
  snippet: string;
}

/**
 * Extract the actor tag from a call site.
 *
 * `markNewSpecInReview(workspaceId, slug, intendedStatus, actor, reason?, markdown?)` — the 4th
 * positional arg is a string literal (e.g. `"db_health"` / `"director:platform"`). We slice from
 * the identifier's `(` and count args by top-level commas (skipping brackets/quotes) to find the
 * 4th, then read the string literal.
 *
 * `authorSpecRowFromMarkdown(workspaceId, slug, markdown, intendedStatus, opts)` — the 5th
 * positional arg is an object literal carrying `intendedStatusSetBy: "..."`. We extract that
 * literal directly from the surrounding text (works whether the object is inline or spans
 * multiple lines).
 *
 * Returns `""` when no tag can be extracted (a non-literal actor is a NEW pattern and the guard
 * should still fire — but with an empty tag it can never match the allow-list, which is the
 * fail-safe direction).
 */
function extractTag(fullText: string, callIdx: number, identifier: MarkdownAuthorIdentifier): string {
  // Advance past the identifier + `(` to the arg list.
  const openIdx = fullText.indexOf("(", callIdx);
  if (openIdx === -1) return "";

  if (identifier === "authorSpecRowFromMarkdown") {
    // Find `intendedStatusSetBy` inside the top-level call by scanning until we close the initial
    // paren. Keep balance counters so nested (), [], {} don't confuse us.
    const key = "intendedStatusSetBy";
    let balance = 1;
    let inStr: '"' | "'" | "`" | null = null;
    for (let i = openIdx + 1; i < fullText.length && balance > 0; i++) {
      const ch = fullText[i];
      if (inStr) {
        if (ch === "\\") { i++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = ch as '"' | "'" | "`"; continue; }
      if (ch === "(" || ch === "[" || ch === "{") balance++;
      else if (ch === ")" || ch === "]" || ch === "}") balance--;
      if (balance <= 0) break;
      if (ch === key[0] && fullText.startsWith(key, i)) {
        // read past key + `:` (with optional whitespace) + a string literal
        let j = i + key.length;
        while (j < fullText.length && /\s/.test(fullText[j])) j++;
        if (fullText[j] !== ":") continue;
        j++;
        while (j < fullText.length && /\s/.test(fullText[j])) j++;
        const q = fullText[j];
        if (q !== '"' && q !== "'" && q !== "`") continue;
        let end = j + 1;
        while (end < fullText.length && fullText[end] !== q) {
          if (fullText[end] === "\\") end += 2;
          else end++;
        }
        const inner = fullText.slice(j + 1, end);
        // Same template-literal handling as `extractStringLiteralIfBare`: a template with an
        // interpolation carries only the STABLE prefix as the tag. That's how the
        // director-coach lane's `` `director:${thread.director_function}` `` shape resolves to a
        // matchable `director:` tag on the allow-list.
        const interp = inner.indexOf("${");
        return interp === -1 ? inner : inner.slice(0, interp);
      }
    }
    return "";
  }

  // markNewSpecInReview — find the 4th top-level positional arg (0-indexed 3).
  const targetArgIdx = 3;
  let balance = 1;
  let argIdx = 0;
  let argStart = openIdx + 1;
  let inStr: '"' | "'" | "`" | null = null;
  for (let i = openIdx + 1; i < fullText.length && balance > 0; i++) {
    const ch = fullText[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch as '"' | "'" | "`"; continue; }
    if (ch === "(" || ch === "[" || ch === "{") balance++;
    else if (ch === ")" || ch === "]" || ch === "}") balance--;
    if (balance === 0) {
      if (argIdx === targetArgIdx) {
        return extractStringLiteralIfBare(fullText.slice(argStart, i));
      }
      break;
    }
    if (balance === 1 && ch === ",") {
      if (argIdx === targetArgIdx) {
        return extractStringLiteralIfBare(fullText.slice(argStart, i));
      }
      argIdx++;
      argStart = i + 1;
    }
  }
  return "";
}

/** If `expr` is a bare string literal (possibly wrapped in whitespace), return its content —
 *  otherwise return "". A template-literal actor with no interpolation is treated as a string. */
function extractStringLiteralIfBare(expr: string): string {
  const trimmed = expr.trim();
  const first = trimmed[0];
  if (first !== '"' && first !== "'" && first !== "`") return "";
  const last = trimmed[trimmed.length - 1];
  if (last !== first) return "";
  const inner = trimmed.slice(1, -1);
  // A template literal with an interpolation (`director:${fn}`) is not a bare literal — but the
  // director-coach lane uses that shape; carry the substring up to the `${` as the tag prefix, so
  // the allow-list can match on it stably.
  const interp = inner.indexOf("${");
  return interp === -1 ? inner : inner.slice(0, interp);
}

/** Scan one file for direct `<identifier>(` invocations. Line-oriented (no cross-line block-comment
 *  state — state trackers are the source of false skips when the file has 25k+ lines and mixed
 *  string/comment content). Instead:
 *   - Skip a line that STARTS with `*` (a JSDoc continuation line).
 *   - Skip a line where the identifier appears AFTER a `//` line comment.
 *   - Skip the DEFINITION line (`function <identifier>(` / `async function <identifier>(`).
 *   - Skip a match whose enclosing identifier equals itself (the wrapper's own internal call —
 *     `markNewSpecInReview`'s body calls `authorSpecRowFromMarkdown`, which is definition-site
 *     wiring, not an autonomous lane). */
function findMarkdownAuthorCalls(rel: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split("\n");
  // Compute per-line char offsets so the multi-line tag extractor can read forward from the call.
  const rawCumOffset: number[] = [0];
  for (let i = 0; i < lines.length; i++) rawCumOffset.push(rawCumOffset[i] + lines[i].length + 1);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // JSDoc continuation lines ` * something authorSpecRowFromMarkdown(...) `. Skip.
    if (/^\s*\*(?:\s|$)/.test(raw)) continue;
    for (const identifier of MARKDOWN_AUTHOR_IDENTIFIERS) {
      const callRe = new RegExp(`\\b${identifier}\\s*\\(`);
      const m = raw.match(callRe);
      if (!m || m.index === undefined) continue;
      // If the identifier is AFTER a `//` on this line, it's inside a line comment. (String
      // literals may CONTAIN `//` but a real string like `"://…"` won't be followed by
      // `identifier(` — the failure mode we care about here is line-comment shadowing, not
      // string-literal shadowing.)
      const lineComment = raw.indexOf("//");
      if (lineComment !== -1 && lineComment < m.index) continue;
      // Definition line.
      if (new RegExp(`\\bfunction\\s+${identifier}\\b`).test(raw)) continue;
      if (new RegExp(`\\btype\\s+${identifier}\\b`).test(raw)) continue;
      // Wrapper's own internal call: `markNewSpecInReview`'s body calls `authorSpecRowFromMarkdown`.
      if (identifier === "authorSpecRowFromMarkdown" && insideWrapperBody(lines, i)) continue;
      const rawIdx = rawCumOffset[i] + m.index;
      const tag = extractTag(text, rawIdx, identifier);
      out.push({
        file: rel,
        line: i + 1,
        identifier,
        tag,
        snippet: raw.trim().slice(0, 160),
      });
    }
  }
  return out;
}

/** True if the current line index is inside `markNewSpecInReview`'s function body. Walks upward,
 *  looking for the wrapper's signature. Stops at the previous function/const declaration to bound
 *  the search — a match beyond that boundary means we are inside a DIFFERENT function. */
function insideWrapperBody(lines: string[], idx: number): boolean {
  // Walk upward up to a bounded number of lines; stop the moment we cross a top-level function
  // declaration OTHER than markNewSpecInReview.
  const WINDOW = 200;
  const start = Math.max(0, idx - WINDOW);
  const otherDecl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;
  for (let i = idx; i >= start; i--) {
    const m = lines[i].match(otherDecl);
    if (m) return m[1] === "markNewSpecInReview";
  }
  return false;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function isSanctioned(f: Finding): boolean {
  return SANCTIONED_MARKDOWN_CALLERS.some(
    (s) => s.file === f.file && s.identifier === f.identifier && s.tag === f.tag,
  );
}

function main() {
  const summary = process.argv.includes("--summary");
  const files = scanFiles();
  const all: Finding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (DEF_SITE_FILES.has(rel)) continue;
    const text = readFileSync(abs, "utf8");
    all.push(...findMarkdownAuthorCalls(rel, text));
  }

  const violations = all.filter((f) => !isSanctioned(f));
  const allowed = all.filter(isSanctioned);

  if (summary) {
    console.log(
      `no-markdown-spec-authoring — ${files.length} file(s) scanned, ${all.length} markdown-author call(s) found`,
    );
    for (const f of all) {
      const tag = isSanctioned(f) ? "ALLOWED" : "VIOLATION";
      console.log(
        `  [${tag}] ${f.file}:${f.line}  ${f.identifier}(... "${f.tag}" ...)  ${f.snippet}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n❌ check-no-markdown-spec-authoring — ${violations.length} new autonomous caller(s) of the retired markdown spec-author path:\n`,
    );
    for (const v of violations) {
      console.error(
        `  • ${v.file}:${v.line}  tag="${v.tag}"  →  ${v.identifier}(...)`,
      );
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\nretire-md-spec-writers-db-is-sole-spec Phase 4 — every autonomous spec-writer lane authors\n` +
      `via authorSpecRowStructured / submitSpec (the STRUCTURED chokepoint). The retired markdown\n` +
      `chokepoint (\`markNewSpecInReview\` / \`authorSpecRowFromMarkdown\`) parses prose Verification\n` +
      `to \`exec_kind='needs_human'\`, which the every-writer-authors-machine-runnable-verifications\n` +
      `gate rejects — the parked-at-CEO failure this whole spec exists to kill.\n` +
      `\n` +
      `Route this call to \`authorSpecRowStructured(...)\` with a typed \`StructuredSpecInput\` — mirror\n` +
      `\`buildRepairSpecInput\` in \`src/lib/repair-agent.ts\` (Phase 2), \`buildRegisterSpecBody\` in\n` +
      `\`src/lib/coverage-register-agent.ts\` (Phase 1), or \`buildStructuredSpecInputFromMarkdown\` in\n` +
      `\`src/lib/author-spec.ts\` (Phase 3). Each phase MUST carry >=1 typed \`exec_kind\` machine check\n` +
      `(at minimum a \`tsc\` default) so the deterministic spec-check runner can verify the fix landed.\n` +
      `\n` +
      `If this call is genuinely unavoidable (a pre-Phase-4 lane awaiting its own conversion spec),\n` +
      `add the (file, identifier, tag, reason) entry to SANCTIONED_MARKDOWN_CALLERS in this script.\n`,
    );
    process.exit(1);
  }

  // Hygiene: warn (not fail) on stale allow-list entries — sanctioned entries matching no real finding.
  const hit = new Set(allowed.map((f) => `${f.file}::${f.identifier}::${f.tag}`));
  const stale = SANCTIONED_MARKDOWN_CALLERS.filter(
    (s) => !hit.has(`${s.file}::${s.identifier}::${s.tag}`),
  );
  if (stale.length) {
    console.warn(
      `⚠ check-no-markdown-spec-authoring — ${stale.length} stale allow-list entry/entries (no matching finding):`,
    );
    for (const s of stale) console.warn(`  • ${s.file} [${s.identifier}] tag="${s.tag}" — ${s.reason}`);
    console.warn(
      `Remove from SANCTIONED_MARKDOWN_CALLERS — the retired call it sanctioned was converted / removed.`,
    );
  }

  console.log(
    `✓ check-no-markdown-spec-authoring — ${files.length} file(s) scanned; ` +
    `${allowed.length} sanctioned markdown-author call(s) (allow-listed pre-Phase-4 debt); 0 unexpected.`,
  );
}

main();
