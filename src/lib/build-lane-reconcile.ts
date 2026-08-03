/**
 * builder-self-heals-stale-build-branch Phase 1 — reconciliation strategy for a build branch
 * relative to origin/main.  Pure — no I/O.  Tested by [[../build-lane-reconcile.test.ts]].
 *
 * The build lane MUST advance a branch's local base to CONTAIN origin/main BEFORE running
 * repo-wide checks (tsc, `check:table-refs-have-migrations`) — those checks assume main as the
 * reference tree, and a stale base whose gap main already closed would otherwise fail a
 * non-real regression.
 *
 * A `git rebase origin/main` linearly replays the branch's commits and SPURIOUSLY conflicts on
 * NON-LINEAR history — the goal-member case named in the spec (a member branch inherits merge
 * commits from the goal branch, which itself carries a main reconciliation, so rebase replays
 * the merges and hits the same conflict every retry) — even though `git merge origin/main`
 * applies CLEAN.  Confirmed 2026-07-11: director-chat-in-leash-execution and machine-declared-
 * verification-and-deterministic-spec-test-runner both parked at needs_attention after the
 * escort/groom loop guard escalated a self-healable staleness to the CEO inbox.
 *
 * So the primary strategy is MERGE for anything non-linear, REBASE only for a truly-linear
 * branch — `chooseReconcile` encodes that choice.  When the primary conflicts, `chooseReconcileFallback`
 * picks a fallback: RECREATE-FRESH when the branch carries no built work AND was never pushed
 * to origin (its local commits are throwaway attempts from an earlier failed session — safe to
 * reset onto the correct base), otherwise the OTHER reconcile approach (merge ↔ rebase).  Only
 * when the fallback ALSO conflicts is the divergence a real semantic overlap that must park
 * needs_attention (Phase 2 names the conflicting files on that park).
 *
 * Invariants: never force-push, never touch main, never drop BUILT commits (a phase with a
 * `build_sha` is durable state — `hasBuiltWork` gates `recreate-fresh` off in the fallback).
 */

export type ReconcileStrategy =
  | "skip"            // origin/main is already an ancestor of HEAD — nothing to reconcile
  | "merge"           // MERGE origin/main INTO the branch (safe for non-linear; no commit rewrite)
  | "rebase"          // REBASE branch onto origin/main (linear replay; clean history for a linear branch)
  | "recreate-fresh"; // reset the branch to the correct base (safe only when no built work is lost)

export interface ReconcileInput {
  /** `git merge-base --is-ancestor origin/main HEAD` → HEAD already contains main.  When true,
   *  no reconcile is needed; the caller may skip merge/rebase entirely. */
  headContainsMain: boolean;
  /** `git log --merges origin/main..HEAD` non-empty → the branch has merge commits since it
   *  diverged from main.  A goal-member branch inherits merge commits from the goal branch's
   *  reconciliation with main; a rebase would try to replay those merges and spuriously conflict. */
  hasMergeCommits: boolean;
  /** Any `spec_phases` row has a non-null `build_sha` — the branch carries a BUILT phase (its
   *  commit is durable state, never dropped).  This gates `recreate-fresh` off in the fallback. */
  hasBuiltWork: boolean;
  /** `origin/<branch>` exists (branch was pushed at least once).  Recreate-fresh would rewrite
   *  the remote → forbidden when true. */
  branchOnRemote: boolean;
}

/**
 * Primary reconciliation choice for a build branch's base advance.
 *
 * - `skip` when the branch already contains origin/main (no-op).
 * - `merge` when the branch has merge commits (non-linear history) — MERGE is the safe default;
 *   REBASE would replay the inherited merges and spuriously conflict on the same files every
 *   retry.  This is the 2026-07-11 director-chat / ceo-org-control-tower shape the spec pins.
 * - `rebase` for a truly-linear branch (no merge commits since divergence) — a clean linear
 *   replay produces the tidiest history.  A merge would work too but leaves a merge commit
 *   the spec branch doesn't need.
 */
export function chooseReconcile(input: ReconcileInput): ReconcileStrategy {
  if (input.headContainsMain) return "skip";
  if (input.hasMergeCommits) return "merge";
  return "rebase";
}

/**
 * Fallback reconciliation when the primary strategy conflicts.
 *
 * - `skip` mirrors the primary when `headContainsMain` (defensive; caller should never call the
 *   fallback in that case, but a wrong call is a no-op).
 * - `recreate-fresh` when the branch carries NO built work AND is NOT on origin — its commits
 *   are throwaway attempts from an earlier failed session; reset onto the correct base loses
 *   nothing.  This is the director-chat-in-leash-execution case named in the spec: box-local
 *   branch, zero built work, human could not reset it remotely.
 * - Otherwise flip the primary strategy: MERGE ↔ REBASE.  Only when the flipped attempt ALSO
 *   conflicts is the divergence semantic (Phase 2's job to park with the conflicting files).
 *
 * `hasBuiltWork` is the HARD gate on `recreate-fresh` — a phase's committed `build_sha` is
 * durable state the fallback must never drop.
 */
export function chooseReconcileFallback(input: ReconcileInput): ReconcileStrategy {
  if (input.headContainsMain) return "skip";
  if (!input.hasBuiltWork && !input.branchOnRemote) return "recreate-fresh";
  return input.hasMergeCommits ? "rebase" : "merge";
}

// ── Phase 2 — escalate only a REAL conflict, and NAME the conflicting files ──────────────────────
// The pre-Phase-1 park message was the generic `rebase-onto-main hit a conflict — refusing to run
// repo-wide checks on a stale tree`.  The CEO card had no way to tell staleness from a real
// conflict, so the founder could not triage it and a self-healable staleness wrongly consumed the
// loop-guard budget.  Phase 1's self-heal ensures a stale-only condition no longer parks at all
// (merge fallback + recreate-fresh + tsc-gate); Phase 2 pins the SHAPE of the park that survives:
// a genuinely un-self-healable semantic conflict, with the conflicting files NAMED.
//
// `extractConflictingFiles` parses the git output emitted by a failing `git merge` or `git rebase`
// and returns the sorted, deduplicated file list.  Pure — regex over the observed CONFLICT-line
// shapes.  The unit test pins the shapes we see in the wild (content merge, modify/delete,
// rename/rename) so a git-output-format shift is caught at test time.
//
// `formatReconcileConflictError` composes the caller's park error message from that list, so the
// CEO card reads "reconcile-with-main conflict on 3 file(s): a.ts, b.ts, c.ts — refusing to run
// repo-wide checks" instead of the generic 2026-07-11 message.

/** Parse the conflicting files out of `git merge` / `git rebase` output. */
export function extractConflictingFiles(gitOutput: string): string[] {
  const files = new Set<string>();
  for (const rawLine of gitOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Most common:  "CONFLICT (content): Merge conflict in <path>"
    let m = /^CONFLICT \([^)]+\): Merge conflict in (\S.*)$/.exec(line);
    if (m) {
      files.add(m[1].trim());
      continue;
    }
    // modify/delete + add/add + create/create:
    //   "CONFLICT (modify/delete): <path> deleted in <ref> and modified in <ref>."
    //   "CONFLICT (add/add):      Merge conflict in <path>"  ← handled above
    //   "CONFLICT (file location): <path> added in <ref> and <path> added in <ref>."
    m = /^CONFLICT \([^)]+\): (\S+) (?:deleted|added|modified|created) in /.exec(line);
    if (m) {
      files.add(m[1].trim());
      continue;
    }
    // rename/rename:  `CONFLICT (rename/rename): Rename "old"->"new-a" in branch "HEAD" rename "old"->"new-b" in "<sha>"`
    // Both destinations conflict on the same source — name the source AND every destination so the
    // operator sees all three paths.
    if (/^CONFLICT \(rename\/rename\):/.test(line)) {
      const renames = line.matchAll(/"([^"]+)"->"([^"]+)"/g);
      for (const rn of renames) {
        files.add(rn[1].trim()); // source (same both times)
        files.add(rn[2].trim()); // destination (different each time)
      }
      continue;
    }
  }
  return [...files].sort();
}

export interface ReconcileConflictErrorInput {
  /** The strategies attempted (primary + fallback) — carried into the message for triage. */
  strategies: string[];
  /** The union of files git named as conflicting across all attempted strategies. */
  files: string[];
}

/** Compose the park `error` string for the Phase 2 real-conflict park. */
export function formatReconcileConflictError(input: ReconcileConflictErrorInput): string {
  const strats = input.strategies.filter(Boolean).join(" + ");
  if (input.files.length === 0) {
    // Real conflict but git output didn't yield a parseable file list — surface the strategies so
    // the log_tail (raw output) is the operator's next stop.
    return `reconcile-with-main hit a real conflict (${strats || "primary + fallback"}) — refusing to run repo-wide checks; see log_tail for the raw git output`;
  }
  const shown = input.files.slice(0, 8); // keep the CEO card scannable
  const overflow = input.files.length - shown.length;
  const list = shown.join(", ") + (overflow > 0 ? `, +${overflow} more` : "");
  return `reconcile-with-main real conflict on ${input.files.length} file(s) (${strats || "primary + fallback"}): ${list} — refusing to run repo-wide checks`;
}

// ── Phase 1 (spec: additive-only-conflict-resolves-itself) — additive-only classifier ────────────
// When primary AND fallback both conflict, today's build lane parks needs_attention on ANY
// conflict.  The 2026-08-02 escalations proved that class is dominated by BOTH-SIDES-APPENDED
// collisions in known append-shaped files: a `test:*` script added to package.json on both
// sides, or a `- bullet` extended to the same brain-page list on both sides.  A rebase resolves
// those in a minute by keeping both, but nothing tells the lane the conflict is provably safe.
//
// This classifier is that proof.  It is PURE — no git, no I/O, unit-tested like the rest of the
// module — because the whole value of the current design is that it never guesses, and this
// tier must not weaken that: it either PROVES additive-only for a file in the allowlist and
// returns a union-resolved content, or it says NOT ADDITIVE with a reason and the lane parks
// exactly as today.
//
// Additive-only requires diff3 conflict style (the caller runs `git config merge.conflictStyle
// diff3` before the failing merge) so we can inspect the common-ancestor block.  A hunk is
// additive iff (a) its base block is empty (nothing was there before → neither side deleted
// or modified a line the other also touched), (b) both `ours` and `theirs` added at least one
// line (a one-sided add resolves cleanly and never conflicts).  A file is additive iff every
// hunk is additive AND all hunks fall inside a per-shape allowed scope (package.json `scripts`
// object; markdown list-item or appended section).  Everything else parks.
//
// Restriction to package.json + docs/brain/**/*.md is deliberate: a source (.ts/.tsx) conflict
// is semantic by default and no heuristic should be trusted with it.  A new append-shaped file
// class arrives with an explicit entry in UNION_RESOLVABLE_PATHS and its own scope check —
// never a wildcard.

/** Allowlist of file-path shapes where a union resolve MAY be safe (still gated per-hunk).
 *  Source files (`.ts`/`.tsx`) are intentionally absent — a source conflict is semantic. */
export const UNION_RESOLVABLE_PATHS: readonly RegExp[] = [
  /^package\.json$/,
  /^docs\/brain\/.+\.md$/,
];

/** One conflict hunk in a file, in either default 2-way or diff3 3-way form. */
export interface ConflictHunk {
  /** Lines between `<<<<<<<` and (`|||||||` or `=======`) — the "ours" side. */
  ours: string[];
  /** Lines between `|||||||` and `=======` — the common ancestor.  Empty (and `hasBaseMarker`
   *  false) when the caller did not run with diff3 conflict style; the classifier treats an
   *  unknown base as NOT ADDITIVE — a plain 2-way hunk cannot prove neither side overwrote a
   *  base line. */
  base: string[];
  /** Lines between `=======` and `>>>>>>>` — the "theirs" side. */
  theirs: string[];
  /** Whether the hunk was written with a `|||||||` marker (diff3 conflict style). */
  hasBaseMarker: boolean;
  /** 0-indexed line number where `<<<<<<<` appears in the input content. */
  startLine: number;
}

/** Parse every conflict hunk in a file's content.  Pure — no I/O.  Handles 2-way + diff3. */
export function parseConflictHunks(content: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  const lines = content.split(/\n/);
  let i = 0;
  while (i < lines.length) {
    if (!/^<{7}(\s|$)/.test(lines[i])) { i++; continue; }
    const startLine = i;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let hasBaseMarker = false;
    let mode: "ours" | "base" | "theirs" = "ours";
    i++;
    while (i < lines.length) {
      const ln = lines[i];
      if (/^\|{7}(\s|$)/.test(ln)) { hasBaseMarker = true; mode = "base"; i++; continue; }
      if (/^={7}$/.test(ln)) { mode = "theirs"; i++; continue; }
      if (/^>{7}(\s|$)/.test(ln)) { i++; break; }
      if (mode === "ours") ours.push(ln);
      else if (mode === "base") base.push(ln);
      else theirs.push(ln);
      i++;
    }
    hunks.push({ ours, base, theirs, hasBaseMarker, startLine });
  }
  return hunks;
}

/** Union-resolve every hunk to `ours ++ theirs` (dropping the base + markers). */
function unionResolve(content: string): string {
  const lines = content.split(/\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^<{7}(\s|$)/.test(lines[i])) { out.push(lines[i]); i++; continue; }
    const ours: string[] = [];
    const theirs: string[] = [];
    let mode: "ours" | "base" | "theirs" = "ours";
    i++;
    while (i < lines.length) {
      const ln = lines[i];
      if (/^\|{7}(\s|$)/.test(ln)) { mode = "base"; i++; continue; }
      if (/^={7}$/.test(ln)) { mode = "theirs"; i++; continue; }
      if (/^>{7}(\s|$)/.test(ln)) { i++; break; }
      if (mode === "ours") ours.push(ln);
      else if (mode === "theirs") theirs.push(ln);
      i++;
    }
    out.push(...ours, ...theirs);
  }
  return out.join("\n");
}

/** Build the OURS view of a file (each hunk replaced by its ours side) and record the ours-view
 *  line range each hunk occupies.  Used to check that hunks fall inside a per-shape scope. */
function oursView(content: string): { lines: string[]; hunkRanges: Array<{ start: number; end: number }> } {
  const rawLines = content.split(/\n/);
  const outLines: string[] = [];
  const hunkRanges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < rawLines.length) {
    if (!/^<{7}(\s|$)/.test(rawLines[i])) { outLines.push(rawLines[i]); i++; continue; }
    const start = outLines.length;
    let mode: "ours" | "base" | "theirs" = "ours";
    i++;
    while (i < rawLines.length) {
      const ln = rawLines[i];
      if (/^\|{7}(\s|$)/.test(ln)) { mode = "base"; i++; continue; }
      if (/^={7}$/.test(ln)) { mode = "theirs"; i++; continue; }
      if (/^>{7}(\s|$)/.test(ln)) { i++; break; }
      if (mode === "ours") outLines.push(ln);
      i++;
    }
    hunkRanges.push({ start, end: Math.max(start, outLines.length - 1) });
  }
  return { lines: outLines, hunkRanges };
}

/** Locate the `"scripts": { ... }` line range in a package.json rendered view, by tracking
 *  brace depth from the scripts opener to its matching close. */
function findScriptsObjectRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => /^\s*"scripts"\s*:\s*\{/.test(l));
  if (start < 0) return null;
  let depth = 0;
  for (let ln = start; ln < lines.length; ln++) {
    const s = lines[ln];
    for (let c = 0; c < s.length; c++) {
      if (s[c] === "{") depth++;
      else if (s[c] === "}") depth--;
    }
    if (depth === 0) return { start, end: ln };
  }
  return null;
}

/** Every line on a hunk side must look like an append-shaped markdown fragment: a list item,
 *  an ATX header (appended section), a blank line, or a list-item continuation. */
function isMarkdownAppendShapedLine(line: string): boolean {
  if (line.trim() === "") return true;
  if (/^\s*[-*+]\s/.test(line)) return true;      // unordered list item
  if (/^\s*\d+\.\s/.test(line)) return true;      // ordered list item
  if (/^#{1,6}\s/.test(line)) return true;        // ATX header — appended section
  if (/^\s{2,}\S/.test(line)) return true;        // indented list-item continuation
  return false;
}

export type AdditiveClassification =
  | { additive: true; unionContent: string; hunks: ConflictHunk[] }
  | { additive: false; reason: string; hunks: ConflictHunk[] };

/**
 * Decide whether a conflicted file is a safe additive-only collision the build lane can
 * resolve by taking both sides.  Returns `{additive:true, unionContent}` only when both the
 * file path is in [[UNION_RESOLVABLE_PATHS]] AND every hunk is provably additive AND every
 * hunk falls inside its file shape's allowed scope.  Otherwise returns a specific reason —
 * the caller parks exactly as it does today.
 *
 * Pure — no I/O.  The caller (Phase 2, build lane) is responsible for having invoked git with
 * `merge.conflictStyle=diff3` so the `|||||||` base marker is present; a hunk missing that
 * marker is a NOT-ADDITIVE verdict, never a guess.
 */
export function classifyAdditiveOnlyConflict(
  input: { path: string; content: string },
): AdditiveClassification {
  const hunks = parseConflictHunks(input.content);
  if (hunks.length === 0) {
    return { additive: false, reason: "no conflict hunks found in file content", hunks };
  }

  // File-shape gate.  Source files (.ts/.tsx) are intentionally NOT here — a source conflict is
  // semantic by default and no heuristic is trusted with it.
  if (!UNION_RESOLVABLE_PATHS.some((r) => r.test(input.path))) {
    return {
      additive: false,
      reason: `path ${input.path} is not in UNION_RESOLVABLE_PATHS (union resolve limited to package.json + docs/brain/**/*.md — source files park by design)`,
      hunks,
    };
  }

  // Per-hunk shape gate.  Every hunk must (a) carry the diff3 base marker, (b) have an EMPTY
  // common ancestor, (c) have BOTH sides non-empty.  Any deviation → not additive.
  for (const [idx, h] of hunks.entries()) {
    if (!h.hasBaseMarker) {
      return {
        additive: false,
        reason: `hunk ${idx + 1} at line ${h.startLine + 1}: missing ||||||| base marker — need diff3 conflict style to prove additive`,
        hunks,
      };
    }
    if (h.base.length !== 0) {
      return {
        additive: false,
        reason: `hunk ${idx + 1} at line ${h.startLine + 1}: common ancestor has ${h.base.length} line(s) — at least one side modified or deleted a base line`,
        hunks,
      };
    }
    if (h.ours.length === 0 || h.theirs.length === 0) {
      return {
        additive: false,
        reason: `hunk ${idx + 1} at line ${h.startLine + 1}: one side is empty (ours=${h.ours.length}, theirs=${h.theirs.length}) — not a both-sides-added collision`,
        hunks,
      };
    }
  }

  // File-shape scope check.
  if (/^package\.json$/.test(input.path)) {
    const view = oursView(input.content);
    const scripts = findScriptsObjectRange(view.lines);
    if (!scripts) {
      return { additive: false, reason: 'package.json has no "scripts" object — union resolve requires the conflict be inside "scripts"', hunks };
    }
    for (const [idx, r] of view.hunkRanges.entries()) {
      if (r.start < scripts.start + 1 || r.end > scripts.end - 1) {
        // +1 / -1 because the scripts opening `{` line and closing `}` line themselves are
        // structural — an added line must sit STRICTLY inside the object body.
        return {
          additive: false,
          reason: `package.json hunk ${idx + 1} at ours-lines ${r.start + 1}-${r.end + 1} is outside the "scripts" object body (lines ${scripts.start + 2}-${scripts.end})`,
          hunks,
        };
      }
    }
  } else if (/^docs\/brain\/.+\.md$/.test(input.path)) {
    for (const [idx, h] of hunks.entries()) {
      for (const ln of h.ours) {
        if (!isMarkdownAppendShapedLine(ln)) {
          return {
            additive: false,
            reason: `docs/brain markdown hunk ${idx + 1}: ours-side line is not append-shaped (list item / header / blank): ${JSON.stringify(ln.slice(0, 80))}`,
            hunks,
          };
        }
      }
      for (const ln of h.theirs) {
        if (!isMarkdownAppendShapedLine(ln)) {
          return {
            additive: false,
            reason: `docs/brain markdown hunk ${idx + 1}: theirs-side line is not append-shaped (list item / header / blank): ${JSON.stringify(ln.slice(0, 80))}`,
            hunks,
          };
        }
      }
    }
  }

  return { additive: true, unionContent: unionResolve(input.content), hunks };
}

// ── Phase 2 (spec: additive-only-conflict-resolves-itself) — post-resolve validators ─────────────
//
// Classification says "the shape is additive"; validation says "the tree we actually wrote is
// safe."  An auto-resolve that lands a broken file is far worse than a park — a broken
// package.json breaks every downstream build; a truncated brain page silently loses knowledge.
// So the caller runs EVERY validator on EVERY auto-resolved file before completing the merge:
//   1. No conflict markers remain anywhere.
//   2. The resolved file is a superset of BOTH prior sides — nothing dropped.
//   3. package.json parses as JSON AND every pre-existing script key from EITHER side survives.
// A failed validation is a PARK, never a retry — no configuration of the resolver would change
// the verdict; the caller must fall through to today's needs_attention path.

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** No conflict markers remain in the file content — the resolver dropped every `<<<<<<<`,
 *  `|||||||`, `=======`, `>>>>>>>` line.  A leftover marker means the resolve was partial. */
export function validateNoConflictMarkers(content: string): ValidationResult {
  const m = /^(?:<{7}|\|{7}|={7}|>{7})(?:\s|$)/m.exec(content);
  if (m) return { ok: false, reason: `conflict marker remains in resolved content: ${JSON.stringify(m[0])}` };
  return { ok: true };
}

/** The resolved file must contain EVERY non-empty line that appeared in ours OR theirs — the
 *  resolve is a union, so nothing either side added may be dropped.  Trims whitespace-only
 *  differences (a re-flowed blank line isn't a lost line).  Set-membership is safe for our
 *  case because additive-only means base is empty, so a base line appearing on both sides is
 *  represented once in the union and matches once on the ours pass and once on the theirs pass. */
export function validateUnionSuperset(
  oursContent: string,
  theirsContent: string,
  resolvedContent: string,
): ValidationResult {
  const present = new Set(resolvedContent.split(/\n/));
  for (const l of oursContent.split(/\n/)) {
    if (l.trim() === "") continue;
    if (!present.has(l)) return { ok: false, reason: `resolved file is NOT a superset — OURS line was dropped: ${JSON.stringify(l.slice(0, 120))}` };
  }
  for (const l of theirsContent.split(/\n/)) {
    if (l.trim() === "") continue;
    if (!present.has(l)) return { ok: false, reason: `resolved file is NOT a superset — THEIRS line was dropped: ${JSON.stringify(l.slice(0, 120))}` };
  }
  return { ok: true };
}

// ── Phase 3 (spec: additive-only-conflict-resolves-itself) — actionable park + first-park escalation
//
// A `reconcile_conflict` park that survives Phase 2's union tier is a genuinely semantic
// conflict (source file, non-append-shaped, mixed with a modification, …).  Today's card
// reads "Build stuck (grooming)" with the reason buried in `agent_jobs.error`.  The CEO
// sees a stuck build; they can't see "package.json needs one line kept from each side".
//
// Two changes:
//   1. `formatConflictResolutionHints(files)` — a pure per-file hint line based on file
//      shape.  package.json / docs/brain markdown are trivial to resolve by hand
//      (Phase 1's classifier said no because a validator refused, or the base wasn't
//      empty, or a scope-check failed — the hint tells the operator the shape); a
//      source file is a semantic merge nobody should guess at.
//   2. The park's `error` string carries the hints — the CEO card / build log both
//      surface them at PARK TIME, not after the loop-guard finally escalates on the
//      third redrive.
//
// A `reconcile_conflict` park does NOT consume `BUILDER_DEFERRED_REDRIVE_MAX` because
// that counter tracks POST-BUILD `completed_with_deferred` redrives ([[roadmap-actions]]
// `redriveDeferredBuildOrEscalate`); a `needs_attention` park never enters that path.
// Its retry lane is [[platform-director]] `escortSweep` reconcile_resolve → pr-resolve,
// which does REAL work (auto-merge) — bounded by `ESCORT_LOOP_GUARD_MAX` and dedup-per-PR.
// Phase 3's guarantee is that the card surfaces its resolution on the FIRST park; the
// autonomous pr-resolve continues to try, and a genuinely unresolvable conflict escalates
// via that lane's normal loop-guard exactly once — never a founder "Build stuck" with no
// context.

/** Per-file resolution hint keyed off file-path shape.  Pure — reads only the path.
 *  Used to make a `reconcile_conflict` park actionable at first surfacing. */
export function conflictResolutionHintFor(path: string): string {
  if (/^package\.json$/.test(path)) {
    return "keep one script line from each side (both sides added to the same `scripts` object)";
  }
  if (/^docs\/brain\/.+\.md$/.test(path)) {
    return "keep the appended list items or sections from each side";
  }
  if (/^package-lock\.json$/.test(path) || /^pnpm-lock\.yaml$/.test(path) || /^yarn\.lock$/.test(path)) {
    return "regenerate the lock file after resolving package.json (`npm install` / `pnpm install` / `yarn install`)";
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
    return "semantic merge — read both sides and decide (source files are excluded from the additive-only tier by design)";
  }
  if (/\.(md|mdx)$/.test(path)) {
    return "manual merge — restrict to markdown that is not a docs/brain/ page";
  }
  return "manual merge — outside the additive-only tier's allowlist";
}

/** Formatter for the actionable resolution block appended to a `reconcile_conflict` park.
 *  One line per file (up to `maxLines`; overflow gets `+N more`) so the CEO card stays
 *  scannable but names EVERY file that needs a decision. */
export function formatConflictResolutionHints(files: string[], opts: { maxLines?: number } = {}): string {
  const maxLines = Math.max(1, opts.maxLines ?? 8);
  if (files.length === 0) return "resolution: inspect the raw git output in log_tail — the file list could not be parsed";
  const lines = files.slice(0, maxLines).map((f) => `${f} — ${conflictResolutionHintFor(f)}`);
  const overflow = files.length - lines.length;
  const tail = overflow > 0 ? `\n+ ${overflow} more file(s) not shown` : "";
  return `resolution:\n  ${lines.join("\n  ")}${tail}`;
}

/** Resolved package.json must parse AND every script key present on either side must survive
 *  in the resolved `scripts` object.  Extracts keys via JSON.parse of each side (both sides,
 *  taken alone, are complete files — git's stage 2 / stage 3 blobs). */
export function validatePackageJsonScriptKeys(
  oursContent: string,
  theirsContent: string,
  resolvedContent: string,
): ValidationResult {
  let resolved: unknown;
  try { resolved = JSON.parse(resolvedContent); }
  catch (e) {
    return { ok: false, reason: `resolved package.json failed to parse as JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const resolvedScripts = ((): Record<string, unknown> | null => {
    if (!resolved || typeof resolved !== "object") return null;
    const s = (resolved as Record<string, unknown>).scripts;
    if (!s || typeof s !== "object") return null;
    return s as Record<string, unknown>;
  })();
  if (!resolvedScripts) {
    return { ok: false, reason: 'resolved package.json has no "scripts" object' };
  }
  const collectScriptKeys = (src: string): Set<string> => {
    try {
      const parsed: unknown = JSON.parse(src);
      if (!parsed || typeof parsed !== "object") return new Set();
      const s = (parsed as Record<string, unknown>).scripts;
      if (!s || typeof s !== "object") return new Set();
      return new Set(Object.keys(s as Record<string, unknown>));
    } catch { return new Set(); }
  };
  const oursKeys = collectScriptKeys(oursContent);
  const theirsKeys = collectScriptKeys(theirsContent);
  for (const k of oursKeys) if (!(k in resolvedScripts)) {
    return { ok: false, reason: `package.json script key dropped from OURS: "${k}"` };
  }
  for (const k of theirsKeys) if (!(k in resolvedScripts)) {
    return { ok: false, reason: `package.json script key dropped from THEIRS: "${k}"` };
  }
  return { ok: true };
}
