/**
 * author-spec — the single chokepoint every spec-author surface goes through to write the spec body to
 * the DB ([[../tables/specs]] + [[../tables/spec_phases]]). DB-ONLY: authoring writes `public.specs` +
 * `public.spec_phases` via the [[../libraries/specs-table]] SDK and nothing else. There is NO
 * `docs/brain/specs/{slug}.md` commit on `main` — the per-spec markdown was retired
 * ([[spec-readers-from-db-retire-parser]] · [[spec-pm-markdown-purge]]); the readers
 * ([[../libraries/brain-roadmap]]) read the DB rows, not disk. Every author surface (planner,
 * director-coach, triage, regression, spec-chat, Vale-fix, db-health, coverage-register, repair, security,
 * migration-fix, storefront-optimizer, developer-message-center, director split lanes) authors here, to
 * the DB, full stop.
 *
 * Two entry points, ONE write path:
 *  - `authorSpecRowFromMarkdown` — author from a markdown body (parses title/owner/parent/phases/verification
 *    out of the markdown). Used by surfaces that already hold a markdown buffer.
 *  - `authorSpecRowStructured` — author from already-typed fields + phases (no markdown parse). Used by the
 *    goal planner, which holds the proposed spec as structured data and never needs a `.md` round-trip.
 * Both run the same Verification enforcement (`assertEveryPhaseHasVerification`) and the same `upsertSpec`.
 *
 * Verification enforcement is a HARD error (throws `MissingVerificationError`) — it runs before the DB write
 * so an untestable spec never reaches `public.spec_phases`. `repair-author-write-surface-real-error-not-
 * swallow` Phase 2 aligned the DB/upsert failure path to also fail LOUD: the inner catch now re-throws the
 * caught error (raw DB / MissingIntent / InvalidParent / …) rather than collapsing to `return false`, and a
 * `getSpec` read-after-write throws `AuthorWriteFailedError` on a silent no-op upsert. Callers propagate
 * the concrete message end-to-end to the parked repair job's `error` column instead of hitting a generic
 * "silent author-write fallout" fallback.
 */
import { parseAuthoredSpecMarkdown, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { errText } from "@/lib/error-text";
import { suggestBrainRefs, hasBrainRefsLine, hasBrainRefsSkip, deriveSuggestedBrainRefs, formatBrainRefsLine } from "@/lib/brain-ref-suggest";
import { getSpec, upsertSpec, type SpecPhaseInput, type SpecStatus as DbSpecStatus, type SpecRow } from "@/lib/specs-table";
import { replaceSpecBrainRefs, parseBrainRefsLineToSlugs, type SpecBrainRefInput } from "@/lib/spec-brain-refs-table";
import {
  upsertPhaseChecks,
  parseVerificationBlobToChecks,
  validateExecutableCheck,
  type SpecPhaseCheckInput,
  type SpecPhaseCheckExecKind,
} from "@/lib/spec-phase-checks-table";
import { resolveFunctionMandates, type FunctionMandate } from "@/lib/function-mandates";
import { assertSpecReviewGate } from "@/lib/spec-review-gate";

/** A phase heading at H2 or (inside `## Phases`) H3. Same rule parseSpec uses. */
function isPhaseHeading(l: string): boolean {
  return /^#{2,3}\s+Phase\b/.test(l);
}

function cleanInline(s: string): string {
  return s
    .replace(/[⏳🚧✅❌]/g, "")
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alias) => alias || link)
    .replace(/\s+/g, " ")
    .trim();
}

/** A `## Verification` / `### Verification` heading (the spec-test checklist). H2 (spec-level) or H3 (under a
 *  phase). Case-insensitive on the word; tolerates a trailing colon. */
function isVerificationHeading(l: string): boolean {
  return /^#{2,3}\s+Verification\b\s*:?\s*$/i.test(l);
}

/**
 * Split a phase's raw body lines into `{ body, verification }`: any `### Verification` (or `## Verification`)
 * subsection embedded inside the phase is pulled OUT of the body and returned as the verification text (the
 * checklist only, heading stripped). The body keeps everything ELSE in source order. The verification section
 * runs from its heading to the next heading of equal-or-shallower depth (so nested bullets stay with it).
 *
 * This is the core fix: the old extractor never separated the two, so a `## Verification` either vanished from
 * the body (orphaned, captured nowhere → empty verification column) or stayed embedded in the body with its
 * heading intact. Either way spec-test saw 0 checks → defaulted to needs_human.
 */
function splitVerificationFromBody(bodyLines: string[]): { body: string; verification: string | null } {
  let vStart = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (isVerificationHeading(bodyLines[i])) { vStart = i; break; }
  }
  if (vStart === -1) {
    return { body: bodyLines.join("\n").trim(), verification: null };
  }
  const vDepth = (bodyLines[vStart].match(/^(#{2,3})/)?.[1] ?? "###").length;
  let vEnd = bodyLines.length;
  for (let k = vStart + 1; k < bodyLines.length; k++) {
    const hm = bodyLines[k].match(/^(#{1,6})\s+/);
    if (hm && hm[1].length <= vDepth) { vEnd = k; break; }
  }
  const before = bodyLines.slice(0, vStart);
  const verificationLines = bodyLines.slice(vStart + 1, vEnd); // drop the Verification heading itself
  const after = bodyLines.slice(vEnd); // any trailing content after the verification block stays in the body
  const body = [...before, ...after].join("\n").trim();
  const verification = verificationLines.join("\n").trim();
  return { body, verification: verification || null };
}

/**
 * Per-phase BODY + VERIFICATION extractor (sibling to parseSpec which only captures title + status). The body
 * is the markdown between this phase heading and the NEXT phase heading / next H2 section, with any embedded
 * `### Verification` subsection SPLIT OUT into `verification` (so the verification column is always populated
 * and the body never retains the Verification heading). Position is 1-indexed and lines up with
 * `parseSpec().phases[i]`.
 *
 * Spec-level `## Verification`: a single top-level Verification H2 (the dominant authoring shape — the
 * spec-chat/Vale instructions ask for ONE `## Verification` section, not a per-phase one) is treated as the
 * checklist for the WHOLE spec and attached to the LAST phase (where the spec-test agent looks for it), unless
 * a phase already carries its own `### Verification`.
 */
export function extractPhaseBodies(raw: string): { title: string; body: string; verification: string | null }[] {
  const lines = raw.split("\n");

  // Pass 1: H2/H3-heading shape (the dominant form).
  const headings: { lineIdx: number; rawTitle: string }[] = [];
  let currentH2: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) currentH2 = lines[i].replace(/^##\s+/, "").trim();
    if (!isPhaseHeading(lines[i])) continue;
    if (lines[i].startsWith("### ") && !/^Phases$/i.test(currentH2 ?? "")) continue;
    const m = lines[i].match(/^#{2,3}\s+(.+?)\s*$/);
    headings.push({ lineIdx: i, rawTitle: m ? m[1] : "" });
  }

  if (headings.length) {
    const out: { title: string; body: string; verification: string | null }[] = [];
    for (let p = 0; p < headings.length; p++) {
      const start = headings[p].lineIdx + 1;
      let end = lines.length;
      for (let k = start; k < end; k++) {
        if (isPhaseHeading(lines[k])) { end = k; break; }
        // A phase body terminates at the next H2 — EXCEPT `## Phases` (a container) and `## Verification`
        // (which, when it lives INSIDE the phase span, is the phase's own checklist and must stay with it so
        // splitVerificationFromBody can pull it into the verification column).
        if (/^##\s+/.test(lines[k]) && !/^##\s+Phases?\s*$/i.test(lines[k]) && !isVerificationHeading(lines[k])) { end = k; break; }
      }
      const { body, verification } = splitVerificationFromBody(lines.slice(start, end));
      out.push({ title: cleanInline(headings[p].rawTitle), body, verification });
    }

    // Spec-level `## Verification`: a top-level Verification section AFTER the last phase (its heading sits
    // outside every phase span above). Attach it to the last phase that has no verification of its own —
    // that's where the spec-test agent reads the checklist from.
    attachSpecLevelVerification(lines, headings, out);
    return out;
  }

  // Pass 2: bullet-style phases under `## Phases`.
  const out: { title: string; body: string; verification: string | null }[] = [];
  let inPhases = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Phases?\s*$/i.test(lines[i])) { inPhases = true; continue; }
    if (inPhases && /^##\s+/.test(lines[i])) break;
    if (!inPhases) continue;
    const bm = lines[i].match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!bm) continue;
    const inner = bm[1].replace(/^[⏳🚧✅❌]\s*/, "");
    const hasEmoji = /^[\s]*[-*]\s+[⏳🚧✅❌]/.test(lines[i]);
    if (!hasEmoji && !/^\*{0,2}(P\d+|Phase\s+\d+)\b/i.test(inner)) continue;
    out.push({ title: cleanInline(bm[1]), body: bm[1].trim(), verification: null });
  }
  if (out.length) attachSpecLevelVerification(lines, [], out);
  return out;
}

/**
 * Find a spec-level `## Verification` H2 that sits AFTER the last phase heading (or, when there are no phase
 * headings at all, anywhere), extract its checklist, and attach it to the LAST phase lacking its own
 * verification. Mutates `out` in place. No-op when there's no such section or every phase already has one.
 */
function attachSpecLevelVerification(
  lines: string[],
  headings: { lineIdx: number; rawTitle: string }[],
  out: { title: string; body: string; verification: string | null }[],
): void {
  if (!out.length) return;
  const lastPhaseStart = headings.length
    ? Math.max(...headings.map((h) => h.lineIdx))
    : -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s/.test(lines[i]) || !isVerificationHeading(lines[i])) continue;
    // Only a Verification H2 strictly after the LAST phase heading is spec-level-and-unconsumed; a
    // Verification H2 that sits within a phase span was already pulled into that phase by Pass 1.
    if (lastPhaseStart !== -1 && i <= lastPhaseStart) continue;
    // Extract from this heading to the next H2 (a sibling section like `## Related`).
    let vEnd = lines.length;
    for (let k = i + 1; k < lines.length; k++) {
      if (/^##\s+/.test(lines[k])) { vEnd = k; break; }
    }
    const verification = lines.slice(i + 1, vEnd).join("\n").trim();
    if (!verification) return;
    // Attach to the last phase without its own verification (fall back to nothing if all have one).
    let target = -1;
    for (let p = out.length - 1; p >= 0; p--) {
      if (!out[p].verification) { target = p; break; }
    }
    if (target === -1) return; // every phase already has its own — leave the spec-level one alone
    out[target].verification = verification;
    return;
  }
}

/**
 * Thrown when a spec is authored with a phase that carries NO non-empty `## Verification` / `### Verification`
 * checklist. A spec with no acceptance check is untestable (spec-test defaults it to needs_human forever) —
 * this is exactly why ~13 historical specs shipped with an empty verification column. The authoring MUST fail
 * loudly at the parse step (before the DB write) rather than silently persisting an empty verification.
 */
export class MissingVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingVerificationError";
  }
}

/**
 * Thrown when a spec is authored with a phase whose BODY is empty/whitespace (`spec-body-never-silently-empty`
 * Phase 1). A 0-byte-body phase is un-buildable — Bo has no guidance to follow — so the build silently no-ops
 * and the agent_job flips to `completed` with nothing merged (the db-index-orders class of stall). The
 * authoring MUST fail LOUDLY at the parse step (before the DB write) rather than persisting a phase row with
 * an empty body that the builder later has to refuse. Sibling to `MissingVerificationError`.
 */
export class EmptyPhaseBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPhaseBodyError";
  }
}

/**
 * Thrown when a spec / phase is authored with an empty (or plain-language-lint-failing) `why` or `what`
 * (pm-structured-intent-and-refs Phase 1). The intent columns are the SHARED plain-language layer
 * (humans + agents both read them) that leads the detail page; a spec that skips them is unreadable to
 * humans + gives agents no motivational anchor. Sibling to `MissingVerificationError` +
 * `EmptyPhaseBodyError` — same "fail-loud-at-the-parse-step" pattern.
 */
export class MissingIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingIntentError";
  }
}

/**
 * Thrown by `markNewSpecInReview` when `authorSpecRowFromMarkdown` returned `false` instead of throwing —
 * i.e. the author chokepoint's INNER try/catch swallowed a raw DB/upsert error into a boolean `false`.
 * (`repair-author-write-surface-real-error-not-swallow` Phase 1.) Before this class existed, the caller
 * (`markNewSpecInReview`) did a bare `await authorSpecRowFromMarkdown(...)`, ignored the boolean, and
 * silently continued — so the repair flow enqueued a `repair_build` for a slug that was NEVER persisted to
 * `public.specs`. Capturing the boolean and throwing this error surfaces the failure to
 * `groupOrAuthorRepairSpec`'s catch, which routes the parked repair job to `needs_attention` instead of
 * phantom-completing. Phase 2 will attach the concrete inner-catch message; today the raw cause is only in
 * the console.warn line inside `authorSpecRowFromMarkdown`.
 */
export class AuthorWriteFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorWriteFailedError";
  }
}

/**
 * Thrown when a spec is authored with a BARE-GOAL parent (one-off-spec-parent hotfix). CLAUDE.md's work
 * hierarchy — `Function → (Mandate | Goal→Milestone) → Spec` — says a spec's parent is a function MANDATE
 * or a goal MILESTONE, NEVER a bare goal. A one-off (standalone) spec parents to a function mandate; only a
 * goal-bound spec parents to a specific milestone. The bug this closes: authoring surfaces (and the
 * submit-spec skill's old worked example) handed one-off specs a bare `[[../goals/{slug}]]` parent with no
 * milestone, which Vale then bounced as `needs_fix` on every review pass — an infinite re-review loop that
 * never built. Sibling to `MissingVerificationError` — same "fail-loud-at-the-parse-step" pattern.
 */
export class InvalidParentError extends Error {
  constructor(
    public readonly parent: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidParentError";
  }
}

const GOAL_PARENT_RE = /\[\[[^\]]*goals\/([a-z0-9][a-z0-9-]*)([^\]]*)\]\]/i;

/**
 * Guard the `Parent:` reference at the authoring chokepoint (one-off-spec-parent hotfix). Rejects the
 * unambiguous "one-off forced onto a bare goal" shape: a `[[../goals/{slug}]]` wikilink with NO milestone
 * anchor AND no `milestoneId` binding. A one-off spec should instead parent to a function MANDATE
 * (`parentKind:"mandate"`, `parentRef:"{owner}#{mandate-slug}"`); a goal-bound spec must name a specific
 * milestone (pass `milestoneId`, or anchor `[[../goals/{slug}#{milestone}]]`).
 *
 * CONSERVATIVE by design — it trusts a caller that has DECLARED a typed parent (`parentKind` mandate/
 * milestone) or bound an explicit `milestoneId` (e.g. the blueprint→build path), and only guards the
 * UN-TYPED authoring surface (the `_author-*.ts` one-offs / markdown / planner defaults) where the bug
 * lives. The fuzzier bare-function / sibling-spec parent shapes are left to Vale + the authoring guidance
 * (submit-spec skill + [[what-makes-a-buildable-spec]] recipe) — throwing on those risks false positives.
 */
export function assertValidParent(
  parent: string,
  opts: { milestoneId?: string | null; parentKind?: "function" | "mandate" | "milestone" | null } = {},
): void {
  // A caller that bound an explicit milestone FK, or declared a typed mandate/milestone parent, has taken
  // responsibility for the anchor — trust it (don't break the blueprint→build path that passes
  // parentKind:'milestone').
  if (opts.milestoneId) return;
  if (opts.parentKind === "mandate" || opts.parentKind === "milestone") return;
  const p = (parent || "").trim();
  // POSITIVE definition (the same rule Vale enforces): a parent is valid iff it resolves to a function
  // MANDATE or a goal MILESTONE. Everything else — a bare goal, a bare function, a sibling-`../specs/`
  // parent, or free-text provenance — is a defect that Vale would bounce every pass. We enforce it at the
  // write chokepoint so a bad parent fails FAST here instead of looping forever in review.
  // parser-strips-parent-wikilink-brackets: parseAuthoredSpecMarkdown UNWRAPS `[[…]]` from the parsed
  // `**Parent:**` value, so a markdown-authored parent reaches here bracket-stripped (e.g.
  // `../functions/platform#infra-devops-reliability`). The old regex REQUIRED the `[[…]]` brackets, so
  // EVERY markdown-path parent lacking a typed parentKind failed here as "free text" — the real reason
  // repair fix-specs kept getting rejected (the #1290/#1295 chain surfaced it). Match `functions/{slug}`
  // WITH OR WITHOUT the brackets; the `# or mandate` guard still keeps genuine free text out. The
  // bracketed forms (structured/display) still contain `functions/{slug}`, so this only WIDENS acceptance.
  const hasFunctionMandate =
    /functions\/[a-z0-9-]+/i.test(p) && (p.includes("#") || /mandate/i.test(p));
  const goalM = p.match(GOAL_PARENT_RE);
  const hasGoalMilestone =
    !!goalM && ((goalM[2] || "").includes("#") || /\(\s*M\s*\d|milestone|\bM\d+\b/i.test(p));
  if (hasFunctionMandate || hasGoalMilestone) return;

  // Build a message tuned to what's actually wrong.
  let why: string;
  if (p.includes("../specs/")) {
    why =
      `Parent points at a sibling spec (\`../specs/…\`). A spec is NEVER the parent of another spec — a fix ` +
      `that relates to an origin spec sets \`relatedSpec\`/\`related_spec\` (a link), and parents to a ` +
      `function mandate.`;
  } else if (goalM) {
    why =
      `Parent names goal "${goalM[1]}" with no specific milestone. A one-off spec parents to a function ` +
      `mandate; a goal-bound spec must anchor to a milestone (pass milestoneId, or [[../goals/${goalM[1]}#{milestone}]]).`;
  } else if (/\[\[[^\]]*functions\//i.test(p)) {
    why =
      `Parent names a function but not a specific mandate. Anchor it to a \`###\` under that function's ` +
      `\`## Mandates\` (e.g. [[../functions/platform#infra-devops-reliability]], or name the mandate in the prose).`;
  } else {
    why =
      `Parent is not a resolvable mandate or milestone (it reads as free text). Set it to a function mandate ` +
      `(parentKind:"mandate", parentRef:"{owner}#{mandate-slug}") or a goal milestone.`;
  }
  throw new InvalidParentError(parent, `${why} — CLAUDE.md: parent = a function mandate OR a goal milestone, never a spec.`);
}

// ── improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate Phase 2 ────────────────
// When a spec is authored with a BARE-FUNCTION parent (`[[../functions/{slug}]]` — matches a function
// but names no specific mandate and doesn't bind a milestone), the assertValidParent gate above throws
// InvalidParentError. Phase 2 makes the chokepoint SELF-CORRECT instead: resolve the function's
// mandates, pick the best fit for the spec's intent (title + why + what), rewrite the parent prose to
// the canonical `[[../functions/{slug}]] — "{Mandate heading}" mandate: {short reason}.` form, and set
// parentKind='mandate' + parentRef='{slug}#{mandate-slug}' — so a bare-function author lands rather
// than bounces. Zero-mandate functions still fail (nothing to anchor to → InvalidParentError).
// ────────────────────────────────────────────────────────────────────────────────────────────────

const BARE_FUNCTION_PARENT_RE = /functions\/([a-z0-9][a-z0-9-]*)/i;

/** True iff `parent` names a function (`functions/{slug}`) but has NO `#anchor`, NO `mandate` keyword,
 *  and NO goal reference — the exact shape assertValidParent would bounce. Returns the extracted
 *  function slug on match, else null. Handles the bracket-stripped shape too (parseAuthoredSpecMarkdown
 *  unwraps `[[…]]` before it reaches here). */
export function detectBareFunctionParent(parent: string): { functionSlug: string } | null {
  const p = (parent || "").trim();
  if (!p) return null;
  const m = p.match(BARE_FUNCTION_PARENT_RE);
  if (!m) return null;
  if (p.includes("#")) return null; // has a `#anchor` — already a specific mandate
  if (/\bmandate\b/i.test(p)) return null; // names "mandate" in prose — already anchored to one
  if (/goals\//i.test(p)) return null; // mixed goal reference — not a pure bare-function parent
  return { functionSlug: m[1].toLowerCase() };
}

/** Minimal English stopword list — plus a handful of author-boilerplate tokens ("spec", "phase")
 *  that appear in every spec and would drown out signal on the best-fit compare. Kept small on
 *  purpose so meaningful mandate-headline terms (build/store/tech/infra/devops/reliability/calibrate
 *  /ticket/escalation) are NOT filtered out. */
const AUTO_ANCHOR_STOPWORDS = new Set<string>([
  "the","a","an","and","or","but","of","in","on","at","to","for","with","by","from","is","are","was",
  "were","be","been","being","this","that","these","those","it","its","as","if","so","not","no","do",
  "does","did","done","have","has","had","will","would","should","can","could","may","might","must",
  "shall","than","then","when","where","which","who","whom","whose","how","why","what","we","us","our",
  "you","your","they","their","them","he","she","him","her","his","hers","me","my","mine","one","two",
  "three","also","just","only","own","same","other","any","all","every","more","most",
  "spec","specs","phase","phases",
]);

/** Tokenize a text into a distinct-lowercase-alphanumeric term set, dropping stopwords + very short
 *  tokens. Distinct so a repeated buzzword doesn't dominate the score. */
function tokenizeForAnchor(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (s || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (AUTO_ANCHOR_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Pick the mandate whose heading+body has the strongest DISTINCT-term overlap with the spec's title +
 *  why + what. Ties → declaration order (first mandate wins), which matches the charter authoring
 *  convention where the primary/most-load-bearing mandate is listed first. Never returns null (called
 *  only when `mandates.length >= 1`). */
export function bestFitMandate(
  mandates: FunctionMandate[],
  spec: { title: string; why: string; what: string },
): FunctionMandate {
  if (mandates.length === 1) return mandates[0];
  const specTerms = tokenizeForAnchor(`${spec.title} ${spec.why} ${spec.what}`);
  let best = mandates[0];
  let bestScore = -1;
  for (const m of mandates) {
    const mTerms = tokenizeForAnchor(`${m.heading} ${m.body}`);
    let hits = 0;
    for (const t of specTerms) if (mTerms.has(t)) hits++;
    if (hits > bestScore) {
      bestScore = hits;
      best = m;
    }
  }
  return best;
}

/** Render the canonical bracketed parent prose the auto-anchor rewrites to. Same shape existing
 *  platform-owned specs use (`[[../functions/platform]] — "Infra & DevOps / reliability" mandate:
 *  {reason}.`) so a downstream reader (Vale, roadmap surfaces) reads a familiar wikilink form. */
function formatAutoAnchoredParentProse(functionSlug: string, heading: string, reason: string): string {
  const clean = (reason || "").trim().replace(/\s+/g, " ");
  const trimmed = clean.length > 140 ? clean.slice(0, 137).replace(/\s+\S*$/, "") + "…" : clean;
  const withStop = /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `[[../functions/${functionSlug}]] — "${heading}" mandate: ${withStop}`;
}

/** The result of an auto-anchor: canonical parent prose + typed parentKind/parentRef pair + the chosen
 *  mandate (so the caller can surface which mandate was picked in the Improve tab's "auto-anchored to
 *  X" hint). */
export interface AutoAnchorResult {
  parent: string;
  parentKind: "mandate";
  parentRef: string;
  mandate: FunctionMandate;
}

/**
 * The Phase 2 auto-anchor decision: given a candidate spec's parent + intent, decide whether the
 * chokepoint should REWRITE the parent to a specific mandate on the named function.
 *
 * Returns:
 *  - `null` when `parent` is NOT a bare-function reference (nothing to auto-anchor — leave the caller's
 *    value alone; assertValidParent will handle it).
 *  - `null` when the function has ZERO mandates (nothing to anchor to — the caller falls through to
 *    assertValidParent which THROWS `InvalidParentError`, preserving the spec's fail-loud behavior for
 *    unclosable parents).
 *  - `AutoAnchorResult` otherwise (exactly one mandate → anchor there; multiple → best-fit by
 *    distinct-term overlap with the spec's title + why + what).
 *
 * Deterministic, no LLM. Reads only `docs/brain/functions/{slug}.md` via [[function-mandates]].
 */
export async function autoAnchorBareFunctionParent(
  parent: string,
  spec: { title: string; why: string; what: string },
): Promise<AutoAnchorResult | null> {
  const bare = detectBareFunctionParent(parent);
  if (!bare) return null;
  const mandates = await resolveFunctionMandates(bare.functionSlug);
  if (mandates.length === 0) return null;
  const chosen = bestFitMandate(mandates, spec);
  const shortReason = spec.title.trim() || spec.why.trim() || "auto-anchored from a bare-function parent";
  return {
    parent: formatAutoAnchoredParentProse(bare.functionSlug, chosen.heading, shortReason),
    parentKind: "mandate",
    parentRef: `${bare.functionSlug}#${chosen.slug}`,
    mandate: chosen,
  };
}

/**
 * Plain-language lint for the intent columns (`why` / `what` / `outcome`). The intent fields are for a
 * SHARED human+agent read — code fences and `file:line` refs belong in the technical body, not here. This
 * check runs alongside `assertEveryNodeHasIntent` so a caller that stuffs code into `why` fails the same
 * way an empty value does. Rejects:
 *   - triple-backtick code fences (```…```)
 *   - `file:line` refs (`src/foo.ts:123`)
 *   - a bare `**Something:**` metadata line (belongs in the body headers, not the plain intent)
 *
 * Length is loose (a paragraph is fine); we only guard against "someone pasted the implementation into
 * why/what".
 */
export function assertIntentIsPlainLanguage(slug: string, field: "why" | "what" | "outcome", value: string): void {
  if (/```/.test(value)) {
    throw new MissingIntentError(
      `spec ${slug} — ${field} contains a code fence (\`\`\`). ${field} is a plain-language intent field ` +
        `for humans + agents; put code snippets in the phase body instead.`,
    );
  }
  if (/\b[\w./-]+\.(?:ts|tsx|js|jsx|sql|md|json|yml|yaml)\b:\d+/.test(value)) {
    throw new MissingIntentError(
      `spec ${slug} — ${field} contains a file:line reference. ${field} is a plain-language intent field ` +
        `for humans + agents; leave file/line refs to the technical body.`,
    );
  }
  if (/^\s*\*\*[A-Z][^:*]{0,40}:\*\*/m.test(value)) {
    throw new MissingIntentError(
      `spec ${slug} — ${field} looks like a metadata header line (\`**Something:**\`). ${field} is a ` +
        `plain-language intent field, not a header block; put the metadata in the spec body.`,
    );
  }
}

/**
 * pm-structured-intent-and-refs Phase 3 — reject any phase authored with zero structured verification
 * checks. Runs after `assertEveryPhaseHasVerification` so the free-text gate still fires first for a
 * fully-empty phase; the structured gate catches "the free-text blob exists but doesn't yield any
 * checks" — the exact "text says something but the checklist is really empty" gap. Throws
 * `MissingVerificationError` (same class as the text gate) so every author surface treats untestable
 * as a single failure mode.
 */
export function assertEveryPhaseHasChecks(
  slug: string,
  phases: { title: string; checks: SpecPhaseCheckInput[] }[],
): void {
  const missing = phases
    .map((p, i) => ({ pos: i + 1, title: p.title, ok: p.checks.length > 0 }))
    .filter((p) => !p.ok);
  if (missing.length) {
    const which = missing.map((m) => `phase ${m.pos}${m.title ? ` (${m.title})` : ""}`).join(", ");
    throw new MissingVerificationError(
      `spec ${slug} ${missing.length === 1 ? "has a phase" : "has phases"} with zero structured checks — ${which} ` +
        `carry no spec_phase_checks rows. Every phase needs >=1 concrete "- On {where}, {do what} → expect {observable result}" check ` +
        `(pm-structured-intent-and-refs Phase 3).`,
    );
  }
}

/**
 * every-spec-writer-authors-machine-runnable-verifications Phase 1 — the CHOKEPOINT gate that lifts
 * "the deterministic runner CAN run machine checks" into "every phase HAS >=1 machine-runnable check."
 * Thrown when a phase's verification carries only prose / only `needs_human` rows — nothing the runner
 * can execute. Same "fail-loud-at-the-parse-step" rail as `MissingVerificationError`; both author paths
 * (`authorSpecRowStructured` + `authorSpecRowFromMarkdown`) run `assertEveryPhaseHasMachineCheck` before
 * the DB write, so the invariant holds for every writer that funnels through the chokepoint (planner,
 * spec-chat, ~17 box-worker author lanes, request-fix). A spec whose phase has zero machine-runnable
 * checks never lands in `public.specs` / `public.spec_phases`.
 */
export class MissingMachineCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingMachineCheckError";
  }
}

/**
 * every-spec-writer-authors-machine-runnable-verifications Phase 1 — reject any phase whose structured
 * checks contain zero VALID machine-runnable rows. A phase passes iff at least one check declares an
 * auto-testable `exec_kind` (tsc | grep | ci_status | http_get | db_probe_readonly | unit_test | build)
 * whose (kind, params) pair passes `validateExecutableCheck`. `needs_human` rows may be present as
 * EXTRA (advisory / subjective / drift) but never as the SOLE verification — that's the exact "prose
 * bullet, nothing to run" shape the retire-Vale / cs-director `npm test` incidents left behind.
 *
 * Runs AFTER `assertEveryPhaseHasChecks` in both author paths so the >=1-check gate still fires first
 * on a fully-empty phase; this gate catches "the checks exist but none is executable." Exported so a
 * caller (Improve tab, planner, request-fix inline) can pre-flight the same predicate before
 * proposing a re-author. Throws `MissingMachineCheckError` with slug + offending phase(s) + the exact
 * reason each phase failed (either "zero auto-testable checks" or the first failing
 * `validateExecutableCheck` reason so the author sees WHY the params were rejected — e.g.
 * `unit_test.script "test" is not a package.json script`).
 */
export function assertEveryPhaseHasMachineCheck(
  slug: string,
  phases: { title: string; checks: SpecPhaseCheckInput[] }[],
  ctx?: { packageScripts?: ReadonlySet<string> },
): void {
  const failures = phases
    .map((p, i) => {
      const reasons: string[] = [];
      let ok = false;
      for (const c of p.checks) {
        const kind: SpecPhaseCheckExecKind | null | undefined = c.exec_kind;
        if (!kind || kind === "needs_human") {
          // Not machine-runnable. Explicit needs_human rows are legal as EXTRA — they just cannot
          // be the sole verification, so keep looking.
          continue;
        }
        const v = validateExecutableCheck({ exec_kind: kind, params: c.params ?? null }, ctx);
        if (v.valid) { ok = true; break; }
        reasons.push(`check ${c.position}: ${v.reason}`);
      }
      return { pos: i + 1, title: p.title, ok, reasons };
    })
    .filter((p) => !p.ok);
  if (failures.length) {
    const which = failures
      .map((f) => {
        const head = `phase ${f.pos}${f.title ? ` (${f.title})` : ""}`;
        if (f.reasons.length) return `${head} — ${f.reasons.join("; ")}`;
        return `${head} — zero auto-testable checks (only prose / only needs_human)`;
      })
      .join("; ");
    throw new MissingMachineCheckError(
      `spec ${slug} ${failures.length === 1 ? "has a phase" : "has phases"} with no machine-runnable ` +
        `verification — ${which}. Every phase needs >=1 check with a valid \`exec_kind\` ` +
        `(tsc | grep | ci_status | http_get | db_probe_readonly | unit_test | build) so the deterministic ` +
        `spec-check runner can actually execute the acceptance criterion. \`needs_human\` rows are allowed ` +
        `as EXTRA advisory / subjective checks but never the sole verification ` +
        `(every-spec-writer-authors-machine-runnable-verifications Phase 1).`,
    );
  }
}

/**
 * Reject any spec / phase whose plain-language `why` or `what` is empty (or a lint failure). Throws
 * `MissingIntentError` (loud, with the slug + which field + which phase). Called by
 * `authorSpecRowStructured` BEFORE the DB write, mirroring `assertEveryPhaseHasVerification` — a spec that
 * doesn't declare its intent never lands in `public.specs` / `public.spec_phases`.
 *
 * The input mirrors the shape a caller hands to `authorSpecRowStructured`: a spec-level `{ why, what }`
 * plus `phases: [{ title, why, what }]`. A phase with an empty title is caught elsewhere — this gate is
 * strictly for the intent columns.
 */
export function assertEveryNodeHasIntent(
  slug: string,
  spec: { why: string; what: string },
  phases: { title: string; why: string; what: string }[],
): void {
  const specWhy = (spec.why ?? "").trim();
  const specWhat = (spec.what ?? "").trim();
  if (!specWhy) {
    throw new MissingIntentError(
      `spec ${slug} has no WHY — the plain-language "why this spec exists" is required (humans + agents ` +
        `both read it as the intent header on the detail page).`,
    );
  }
  if (!specWhat) {
    throw new MissingIntentError(
      `spec ${slug} has no WHAT — the plain-language "what changes when this ships" is required.`,
    );
  }
  assertIntentIsPlainLanguage(slug, "why", specWhy);
  assertIntentIsPlainLanguage(slug, "what", specWhat);
  const missing = phases
    .map((p, i) => ({
      pos: i + 1,
      title: p.title,
      missingWhy: !((p.why ?? "").trim()),
      missingWhat: !((p.what ?? "").trim()),
    }))
    .filter((p) => p.missingWhy || p.missingWhat);
  if (missing.length) {
    const which = missing
      .map((m) => {
        const bits = [m.missingWhy ? "no why" : null, m.missingWhat ? "no what" : null].filter(Boolean).join(" + ");
        return `phase ${m.pos}${m.title ? ` (${m.title})` : ""} — ${bits}`;
      })
      .join("; ");
    throw new MissingIntentError(
      `spec ${slug} ${missing.length === 1 ? "has a phase" : "has phases"} with missing intent — ${which}. ` +
        `Every phase needs a plain-language why + what (same rail as the verification gate).`,
    );
  }
  for (const p of phases) {
    if (p.why) assertIntentIsPlainLanguage(`${slug}#${p.title}`, "why", p.why);
    if (p.what) assertIntentIsPlainLanguage(`${slug}#${p.title}`, "what", p.what);
  }
}

/**
 * Reject any phase that has no non-empty Verification section. Throws `MissingVerificationError` (loud, with
 * the slug + the offending phase position + title) so the authoring path FAILS rather than writing an empty
 * verification column. This is the single enforcement chokepoint — `authorSpecRowFromMarkdown` runs it before
 * `upsertSpec`, so every author surface (planner, spec-chat, triage, regression, repair, …) inherits it.
 *
 * `phaseBodies` is the output of `extractPhaseBodies` (which already split spec-level `## Verification` onto
 * the last phase). A phase whose `verification` is null/empty/whitespace fails. A spec with zero phases also
 * fails — there's nothing to test.
 */
export function assertEveryPhaseHasVerification(
  slug: string,
  phaseBodies: { title: string; body: string; verification: string | null }[],
): void {
  if (!phaseBodies.length) {
    throw new MissingVerificationError(
      `spec ${slug} has no phases — every spec needs at least one phase with a non-empty "## Verification" (>=1 concrete acceptance check)`,
    );
  }
  const missing = phaseBodies
    .map((p, i) => ({ pos: i + 1, title: p.title, ok: !!(p.verification && p.verification.trim()) }))
    .filter((p) => !p.ok);
  if (missing.length) {
    const which = missing
      .map((m) => `phase ${m.pos}${m.title ? ` (${m.title})` : ""}`)
      .join(", ");
    throw new MissingVerificationError(
      `spec ${slug} ${missing.length === 1 ? "has a phase" : "has phases"} with no Verification — ${which} ` +
        `has no "## Verification" / "### Verification" section (or it's empty). Every phase needs >=1 concrete ` +
        `acceptance check ("- On {where}, {do what} → expect {observable result}"). Add a Verification section ` +
        `so the spec is testable — no untestable specs.`,
    );
  }
}

/**
 * spec-body-never-silently-empty Phase 1 — reject any phase whose BODY is empty/whitespace. A phase with no
 * body carries no guidance for Bo to build against, so the build silently no-ops and the agent_job flips to
 * `completed` with nothing merged (the db-index-orders class of stall). Enforcement lives at the author
 * chokepoint so an un-buildable phase row never reaches `public.spec_phases`. Throws `EmptyPhaseBodyError`
 * (loud, with slug + offending phase position + title).
 *
 * Sibling gate to `assertEveryPhaseHasVerification`: same shape (`{ title, body }[]`, throws before the DB
 * write), enforces the OTHER half of "no un-buildable spec." Both author entry points
 * (`authorSpecRowStructured` + `authorSpecRowFromMarkdown`) run it after the verification gate so every
 * author surface (planner, spec-chat, triage, regression, repair, db-health, coverage-register, security…)
 * inherits the check.
 */
export function assertEveryPhaseHasBody(
  slug: string,
  phaseBodies: { title: string; body: string }[],
): void {
  if (!phaseBodies.length) {
    // Guard here too so a caller that skips the verification gate still hits a loud failure on a phaseless spec.
    throw new EmptyPhaseBodyError(
      `spec ${slug} has no phases — an un-buildable spec cannot be authored (spec-body-never-silently-empty)`,
    );
  }
  const empty = phaseBodies
    .map((p, i) => ({ pos: i + 1, title: p.title, ok: !!(p.body && p.body.trim()) }))
    .filter((p) => !p.ok);
  if (empty.length) {
    const which = empty
      .map((m) => `phase ${m.pos}${m.title ? ` (${m.title})` : ""}`)
      .join(", ");
    throw new EmptyPhaseBodyError(
      `spec ${slug} ${empty.length === 1 ? "has a phase" : "has phases"} with an empty body — ${which} ` +
        `carries no guidance for the builder to follow. An empty-body phase is un-buildable (Bo has nothing to ` +
        `build), so the job would silently complete with no merged changes. Add the phase body so the spec is ` +
        `buildable — no silently-empty specs.`,
    );
  }
}

/**
 * Extract the plain-language `**Why:**` and `**What:**` header lines a markdown-authored spec may carry
 * (pm-structured-intent-and-refs Phase 1). Both are optional in a markdown body today — the structured
 * chokepoint is the HARD gate; the markdown path is SOFT (extract when present, else pass null through
 * and log at the caller) so existing surfaces keep authoring while they migrate to the new shape.
 *
 * Accepts single-line headers (`**Why:** short reason`) and short multi-line paragraphs following the
 * header (until the next `**Something:**` header, `##` heading, or blank line). Case-insensitive on the
 * label. Returns cleaned-inline text (wikilinks resolved, bold stripped) so the intent column reads as
 * plain prose.
 */
export function extractIntentHeaders(raw: string): { why: string | null; what: string | null } {
  const lines = raw.split("\n");
  const collect = (label: "Why" | "What"): string | null => {
    const re = new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.*)$`, "i");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      let text = m[1].trim();
      // Absorb short continuation lines (until a blank line, a `**Header:**`, or a `##` heading).
      for (let k = i + 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l.trim()) break;
        if (/^\*\*[A-Za-z][^:*]{0,40}:\*\*/.test(l)) break;
        if (/^#{1,6}\s+/.test(l)) break;
        text = `${text} ${l.trim()}`;
      }
      const cleaned = cleanInline(text);
      return cleaned || null;
    }
    return null;
  };
  return { why: collect("Why"), what: collect("What") };
}

/**
 * every-spec-writer-authors-machine-runnable-verifications Phase 2 — extract a `**Human-review:**` header
 * from the markdown body. Optional; absent → null. Multi-line paragraphs are absorbed until the next
 * `**Header:**` / heading / blank line (same shape as `extractIntentHeaders`). The extracted note is
 * OPTIONAL and NEVER blocks author / fold / promote / merge — it's the founder-facing advisory prompt.
 * A caller's `opts.humanReview` still wins (undefined → try the markdown header; null → clear it).
 */
export function extractHumanReviewHeader(raw: string): string | null {
  const lines = raw.split("\n");
  const re = /^\*\*Human-review:\*\*\s*(.*)$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    let text = m[1].trim();
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k];
      if (!l.trim()) break;
      if (/^\*\*[A-Za-z][^:*]{0,40}:\*\*/.test(l)) break;
      if (/^#{1,6}\s+/.test(l)) break;
      text = `${text} ${l.trim()}`;
    }
    const cleaned = cleanInline(text);
    return cleaned || null;
  }
  return null;
}

/** no-spec-parent — `**Related-spec:** <slug>` (or `[[<slug>]]`) line: the origin-spec LINK a fix-spec
 *  points at (persists to `specs.related_spec`), so a self-healing agent references the fixed spec WITHOUT
 *  putting it in the parent. Returns the slug (wikilink brackets/`../specs/` stripped), or null. */
export function extractRelatedSpecHeader(raw: string): string | null {
  for (const l of raw.split("\n")) {
    const m = l.match(/\*\*Related-spec:\*\*\s*(.+?)\s*$/i);
    if (m) {
      const v = cleanInline(m[1]).replace(/^\[\[|\]\]$/g, "").replace(/^\.\.\/specs\//, "").trim();
      return v || null;
    }
  }
  return null;
}

/** `**Repair-signature:** `…`` line (box Repair-Agent specs). Returns the SIGNATURE TEXT, not just presence. */
export function extractRepairSignature(raw: string): string | null {
  for (const l of raw.split("\n")) {
    const m = l.match(/\*\*Repair-signature:\*\*\s*`([^`]+)`/i);
    if (m) return m[1].trim();
    const m2 = l.match(/\*\*Repair-signature:\*\*\s*(.+?)\s*$/i);
    if (m2) return cleanInline(m2[1]);
  }
  return null;
}

/** `**Regression-of:** [[<slug>]]` + `**Regression-signature:** `<sig>`` (box Regression-Agent specs). */
export function extractRegressionHeaders(raw: string): { ofSlug: string | null; signature: string | null } {
  let ofSlug: string | null = null;
  let signature: string | null = null;
  for (const l of raw.split("\n")) {
    if (ofSlug === null) {
      const m = l.match(/\*\*Regression-of:\*\*\s*\[\[([^\]|]+)/i);
      if (m) ofSlug = m[1].trim().replace(/^.*\//, "").replace(/\.md$/, "");
    }
    if (signature === null) {
      const m = l.match(/\*\*Regression-signature:\*\*\s*`([^`]+)`/i);
      if (m) signature = m[1].trim();
      else {
        const m2 = l.match(/\*\*Regression-signature:\*\*\s*(.+?)\s*$/i);
        if (m2) signature = cleanInline(m2[1]);
      }
    }
    if (ofSlug !== null && signature !== null) break;
  }
  return { ofSlug, signature };
}

/** Map a parseSpec SpecStatus to the specs.status DB enum. `rejected` is a phase-only state and never a
 *  whole-spec column — fall back to `planned`. `in_testing` is purely DERIVED at read time
 *  (preview-test-promote-pipeline M3 — `in_testing` derived status) and never stored on `specs.status`
 *  (which carries only explicit lifecycle overrides) — fall back to `in_progress` so the stored row keeps
 *  reflecting "work is mid-build". `folded` is reachable only via the fold worker. */
function toDbStatus(s: SpecStatus): DbSpecStatus {
  if (s === "rejected") return "planned";
  if (s === "in_testing") return "in_progress";
  return s as DbSpecStatus;
}

export interface AuthorSpecOpts {
  /** Override the rolled-up status. When omitted, the spec lands `in_review` (the spec-review-agent default
   *  for a freshly-authored spec). The DB trigger rolls this from the phases on the next phase write. */
  status?: DbSpecStatus;
  /** Optional: pre-typed regression-of slug. Falls back to parsing the markdown headers. */
  regressionOfSlug?: string | null;
  /** Optional: pre-typed regression signature. Falls back to parsing the markdown headers. */
  regressionSignature?: string | null;
  /** Optional: pre-typed repair signature. Falls back to parsing the markdown headers. */
  repairSignature?: string | null;
  /** no-spec-parent — origin-spec slug this fix-spec RELATES to (persists to `specs.related_spec`). A
   *  self-healing agent (repair / db-health / security / regression / coverage) sets this INSTEAD of an
   *  `extends [[../specs/…]]` parent; the parent stays a function mandate. Omit / null for a normal spec. */
  relatedSpec?: string | null;
  /** Optional: who set the intended_status (the author surface — `planner`, `director-coach`, etc.). */
  intendedStatusSetBy?: string | null;
  /** Optional: bind the authored spec to a goal milestone (`goal_milestones.id`). The goal planner passes
   *  the milestone the proposed spec attaches under so the goal→milestone→spec link is made AT author time
   *  (db-driven; no separate `attachSpecToMilestone` round-trip). Omit / null for a standalone spec. */
  milestoneId?: string | null;
  /** pm-structured-intent-and-refs Phase 2 — typed parent kind. When set, `parentRef` MUST also be set;
   *  the CI enforcer validates the pair resolves to a real function slug / mandate key / milestone id. */
  parentKind?: "function" | "mandate" | "milestone" | null;
  /** pm-structured-intent-and-refs Phase 2 — the typed parent value (function slug, mandate key, or
   *  milestone id). Mirrors the `milestoneId` typed FK for the milestone case. */
  parentRef?: string | null;
  /** pm-structured-intent-and-refs Phase 2 — structured brain refs the author picked (replaces the
   *  free-text `**Brain refs:**` line). Omit → the chokepoint derives from summary + phase bodies via
   *  the existing suggester. Each ref carries a canonical `kind/name` slug + an optional phase link. */
  brainRefs?: Array<{ brain_slug: string; phase_id?: string | null }>;
  /** improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate Phase 2 — best-effort callback
   *  fired IFF the chokepoint auto-anchored a bare-function parent to a specific mandate. The Improve tab
   *  uses this to display "auto-anchored to X" back to the human author, so the fallback is transparent
   *  (Phase 3 makes it rare rather than routine, but never invisible). Ignored errors — the auto-anchor
   *  itself still applies. */
  onAutoAnchor?: (result: AutoAnchorResult) => void;
  /** every-spec-writer-authors-machine-runnable-verifications Phase 2 — OPTIONAL, non-blocking founder-
   *  facing advisory note (the "eyeball this after ship" prompt). Persists to `specs.human_review`.
   *  When set on the structured path, wins over any `spec.human_review` on the input. On the markdown
   *  path, wins over the extracted `**Human-review:**` header. `undefined` → parse the markdown header
   *  (markdown path) or preserve the stored value (structured path); explicit `null` clears it.
   *  NEVER read by the fold gate, promote gate, or deterministic spec-check runner. */
  humanReview?: string | null;
}

/** A structured phase a caller hands to `authorSpecRowStructured` — title + body + the verification checklist
 *  (REQUIRED-non-empty, enforced before the write). `status` defaults to `planned` (a freshly-authored
 *  phase hasn't shipped). */
export interface StructuredPhaseInput {
  title: string;
  body: string;
  /** The phase's `## Verification` checklist. Must be non-empty — `assertEveryPhaseHasVerification` rejects
   *  a phase with no acceptance check. */
  verification: string;
  status?: Phase;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this phase exists. Must be non-empty —
   *  `assertEveryNodeHasIntent` rejects a phase with no plain-language intent. */
  why: string;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this phase ships. */
  what: string;
  /** pm-structured-intent-and-refs Phase 3 — the phase's structured verification checks as [{position,
   *  description, kind}]. When omitted, the chokepoint DERIVES them by splitting `verification` on
   *  bullet lines. Either way the ≥1-check gate fires; a phase that yields zero checks throws. */
  checks?: SpecPhaseCheckInput[];
}

/** The structured spec a caller hands to `authorSpecRowStructured` (no markdown parse). */
export interface StructuredSpecInput {
  title: string;
  summary: string | null;
  owner: string;
  parent: string;
  blocked_by?: string[];
  critical?: boolean;
  autoBuild?: boolean;
  phases: StructuredPhaseInput[];
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this spec exists (same value humans +
   *  agents read as the detail page's intent header). Must be non-empty. */
  why: string;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this spec ships. Must be
   *  non-empty. */
  what: string;
  /** every-spec-writer-authors-machine-runnable-verifications Phase 2 — OPTIONAL, non-blocking
   *  founder-facing advisory note ("after ship, open /dashboard/x and confirm the layout reads
   *  right"). Absence is fine — a spec ships without one by default. Machine-runnable
   *  `spec_phase_checks` are the sole ship gate; this note NEVER gates fold/promote/merge and is
   *  never read by the deterministic spec-check runner. */
  human_review?: string | null;
}

/** The content shape a re-author compares against the existing row to decide "did the content change?" —
 *  title + summary + the per-position (title, body, verification) tuples. Owner/parent/blockers are
 *  metadata, not the spec's reviewable CONTENT; a change there alone doesn't warrant a Vale re-review. */
interface ReauthorContent {
  title: string;
  summary: string | null;
  phases: { title: string; body: string; verification: string | null }[];
}

/** Normalize a string for content comparison — trim + collapse inner whitespace so a cosmetic reflow
 *  (re-wrapped line, trailing space) is NOT counted as a content change. */
function normForCompare(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Coerce `owner` to the bare function slug ShopCX stores in `specs.owner` — strip a `[[../functions/…]]`
 *  wikilink wrapper if a caller mistakenly hands us one. The DB shape is the bare slug (`platform`,
 *  `growth`, …); 170 rows carry that shape. Two authoring surfaces (pre-merge-fix + request-fix-inline)
 *  regressed to the wikilink form and stuck rows in Vale under "Mangled Owner wikilink" — this is the
 *  boundary guard so no future author surface can regress the shape again. */
function normalizeOwnerSlug(owner: string): string {
  return owner.replace(/^\[\[\.\.\/functions\/([^\]]+)\]\]$/, "$1").trim();
}

/** Did the re-authored content materially DIFFER from the stored row? Compares title, summary, and each
 *  phase's (title, body, verification) after whitespace-normalization. A different phase COUNT is a change.
 *  Conservative: when in doubt (a field genuinely differs) it returns true so the spec re-opens. */
function contentChanged(existing: SpecRow, next: ReauthorContent): boolean {
  if (normForCompare(existing.title) !== normForCompare(next.title)) return true;
  if (normForCompare(existing.summary) !== normForCompare(next.summary)) return true;
  const ex = [...existing.phases].sort((a, b) => a.position - b.position);
  if (ex.length !== next.phases.length) return true;
  for (let i = 0; i < next.phases.length; i++) {
    if (normForCompare(ex[i].title) !== normForCompare(next.phases[i].title)) return true;
    if (normForCompare(ex[i].body) !== normForCompare(next.phases[i].body)) return true;
    if (normForCompare(ex[i].verification) !== normForCompare(next.phases[i].verification)) return true;
  }
  return false;
}

/**
 * re-author-re-opens-dismissed invariant — the single root patch. When an EXISTING spec is re-authored AND
 * its content CHANGED, RE-OPEN it so the corrected content is re-evaluated rather than carried under the
 * stale verdict:
 *   1. reset the review signals + flip to `in_review` (`markSpecCardBackToReview` clears `vale_pass`,
 *      `vale_review_passed_at`, `ada_disposition`, `intended_status` and sets `specs.status='in_review'`),
 *      so Vale re-reviews the NEW content and Ada re-disposes from scratch; AND
 *   2. clear the standing init/groom DISMISSAL ledger (`clearDirectorSpecDismissals`) so the init/groom
 *      lanes' dedup (`alreadyInitiated`/`alreadyGroomed`) no longer skips the corrected spec.
 *
 * This is the gap behind `migration-pricing-preserved-base-above-msrp`: a spec dismissed for a WRONG premise,
 * then corrected, sat dead under the old rejection (status derived planned, stale Vale stamp, dismissal still
 * in effect). Same class as the orphan-park fixes — a corrected-after-rejection spec must never silently stay
 * dead.
 *
 * Called AFTER the upsert with the pre-upsert `existing` row + the new content. A no-op when: the spec is
 * brand-new (no existing row — nothing to re-open, the upsert's default in_review already holds it), the
 * content is identical (an idempotent re-author / a metadata-only touch — don't churn Vale), or the spec is
 * already `in_review` AND carries no dismissal (already open). Best-effort + never throws — a re-open hiccup
 * must never fail the authoring write that already landed.
 */
async function reopenIfReauthoredAndChanged(
  workspaceId: string,
  slug: string,
  existing: SpecRow | null,
  next: ReauthorContent,
): Promise<void> {
  try {
    if (!existing) return; // brand-new spec — the upsert default (`in_review`) already holds it for Vale.
    if (existing.status === "folded") return; // a folded spec is archived; re-author shouldn't resurrect it here.
    if (!contentChanged(existing, next)) return; // identical / metadata-only re-author — leave the verdict.

    const reason =
      `re-authored with changed content → re-opening: reset review signals (vale_pass / vale_review_passed_at / ` +
      `ada_disposition) + status=in_review so Vale re-reviews the NEW content, and cleared any standing ` +
      `init/groom dismissal so the corrected spec re-enters the build pipeline.`;

    // 1) Reset the review signals + flip to in_review (the SHARED send-back writer — it already clears
    //    vale_pass / vale_review_passed_at / ada_disposition / intended_status and sets status='in_review').
    const { markSpecCardBackToReview } = await import("@/lib/spec-card-state");
    await markSpecCardBackToReview(workspaceId, slug, { actor: "author-spec:reauthor-reopen", reason });

    // 2) Clear the standing init/groom dismissal ledger so the dedup no longer skips the corrected spec.
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { clearDirectorSpecDismissals } = await import("@/lib/director-activity");
    await clearDirectorSpecDismissals(createAdminClient(), workspaceId, slug, reason);
  } catch (e) {
    console.warn(`[author-spec] reopenIfReauthoredAndChanged ${slug} (best-effort) failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Author / re-author a spec to the DB from already-typed fields + phases — NO markdown parse. The DB-driven
 * entry point for surfaces (the goal planner) that hold the proposed spec as structured data and must never
 * depend on a `.md` scratch buffer on disk. Same Verification enforcement + same `upsertSpec` write path as
 * the markdown variant. Idempotent (UPSERT by `(workspace_id, slug)`; phases replaced by `(spec_id, position)`).
 *
 * Verification is a HARD error: a phase with an empty `verification` throws `MissingVerificationError` BEFORE
 * the DB write (an untestable spec never lands). A genuine DB/upsert error is best-effort (logged → `false`).
 */
// ── Runaway-authoring circuit-breaker (2026-07-03 incident) ──────────────────────────────────────
// A single security finding recursively authored a chain of near-duplicate fix specs (the fused pre-merge
// review of a fix-spec's OWN branch found a vuln → authored another fix spec → …). The security→fix-phases
// reroute + the fix-blocker→fix-phases reroute remove the two KNOWN spawners; this is the CATCH-ALL backstop
// at the sole author chokepoint: if DERIVATIVE fix specs are being authored faster than a human could be
// driving them, HALT the next one + escalate to the CEO instead of silently spawning more. Fails OPEN — a
// read blip never blocks a legitimate author.
const RUNAWAY_FIX_WINDOW_MIN = 30;
const RUNAWAY_FIX_THRESHOLD = 5; // the 6th derivative-fix spec authored inside the window halts + escalates
const DERIVATIVE_FIX_SLUG_RE = /-fix-blocker-|-fix-tooling-|-fix-/;

/** Count derivative-fix specs authored in the window; at/over threshold, HALT + escalate to the CEO. */
async function isRunawayFixAuthoring(workspaceId: string, slug: string): Promise<boolean> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const since = new Date(Date.now() - RUNAWAY_FIX_WINDOW_MIN * 60_000).toISOString();
    const { data } = await admin
      .from("specs")
      .select("slug, parent, repair_signature, regression_of_slug, created_at")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since);
    const recentFixes = (data ?? []).filter(
      (r) =>
        !!r.repair_signature ||
        !!r.regression_of_slug ||
        DERIVATIVE_FIX_SLUG_RE.test(String(r.slug)) ||
        (typeof r.parent === "string" && r.parent.includes("../specs/")),
    );
    if (recentFixes.length < RUNAWAY_FIX_THRESHOLD) return false;
    const diagnosis =
      `Runaway auto-authoring detected: ${recentFixes.length} derivative fix spec(s) authored in the last ` +
      `${RUNAWAY_FIX_WINDOW_MIN} min (threshold ${RUNAWAY_FIX_THRESHOLD}). Halted the author of "${slug}" and ` +
      `escalated instead of spawning another. Recent: ${recentFixes.map((r) => r.slug).slice(0, 12).join(", ")}.`;
    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "escalated",
        specSlug: slug,
        reason: diagnosis,
        metadata: { signature: "runaway-fix-authoring-circuit-breaker", halted_slug: slug, window_min: RUNAWAY_FIX_WINDOW_MIN, recent_count: recentFixes.length },
      });
    } catch { /* best-effort */ }
    // One CEO card per workspace for a runaway burst (dedupe_key), only if none is already live.
    try {
      const dedupeKey = `runaway-authoring:${workspaceId}`;
      const { data: existingCard } = await admin
        .from("dashboard_notifications")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("metadata->>dedupe_key", dedupeKey)
        .eq("dismissed", false)
        .maybeSingle();
      if (!existingCard) {
        await admin.from("dashboard_notifications").insert({
          workspace_id: workspaceId,
          type: "agent_approval_request",
          title: `Runaway spec authoring halted (${recentFixes.length} fixes / ${RUNAWAY_FIX_WINDOW_MIN}m)`,
          body: `🛑 Platform circuit-breaker: ${diagnosis}`,
          link: "/dashboard/roadmap",
          metadata: { routed_to_function: "ceo", escalation_kind: "runaway_authoring", dedupe_key: dedupeKey, autonomous: true },
        });
      }
    } catch { /* best-effort */ }
    console.warn(`[author-spec] CIRCUIT-BREAKER halted ${slug}: ${recentFixes.length} derivative fixes in ${RUNAWAY_FIX_WINDOW_MIN}m`);
    return true;
  } catch {
    return false; // fail OPEN — never block a legitimate author on a breaker read blip
  }
}

/**
 * single-source-of-truth for a goal-bound spec's `**Parent:**` line. The bound `milestone_id` is the
 * TRUTH; the Parent PROSE is its PROJECTION — generated here, never hand-authored — so it can never
 * drift to a bare-goal. This closes the systematic 2026-07 planner bounce: the plan-author set
 * `milestone_id` correctly on every spec but wrote the Parent prose as the bare goal slug, and Vale
 * (which reads the rendered prose, not the FK) bounced all 14. Answers "why hand-write the parent at
 * all" — for a goal-bound spec you don't; it's a rendering of the milestone it's bound to.
 */
export function formatMilestoneParentProse(goalSlug: string, position: number, title: string): string {
  const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `[[../goals/${goalSlug}#${anchor}]] — M${position} "${title}" milestone.`;
}

/** Look up the bound milestone → its goal, and render the canonical Parent prose. Best-effort: a read
 *  miss returns null and the caller leaves the author-supplied parent untouched. */
async function deriveMilestoneParentProse(milestoneId: string): Promise<string | null> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data: ms } = await admin
      .from("goal_milestones")
      .select("goal_id, title, position")
      .eq("id", milestoneId)
      .maybeSingle();
    if (!ms || !ms.goal_id) return null;
    const { data: goal } = await admin.from("goals").select("slug").eq("id", ms.goal_id).maybeSingle();
    if (!goal?.slug) return null;
    return formatMilestoneParentProse(goal.slug, Number(ms.position) || 1, String(ms.title || "milestone"));
  } catch {
    return null;
  }
}

export async function authorSpecRowStructured(
  workspaceId: string,
  slug: string,
  spec: StructuredSpecInput,
  intendedStatus: "planned" | "deferred",
  opts: AuthorSpecOpts = {},
): Promise<boolean> {
  // ENFORCEMENT before the DB write — reuse the SAME gates the markdown path runs so every author surface
  // (markdown OR structured) inherits "no untestable spec" AND "no silently-empty spec." Map structured
  // phases into the gate's shape.
  const phaseBodies = spec.phases.map((p) => ({
    title: p.title,
    body: p.body,
    verification: p.verification && p.verification.trim() ? p.verification.trim() : null,
  }));
  assertEveryPhaseHasVerification(slug, phaseBodies);
  // spec-body-never-silently-empty Phase 1 — reject a phase with an empty body BEFORE the DB write. An
  // un-buildable spec (0-byte body) is exactly what silently completed the db-index-orders build.
  assertEveryPhaseHasBody(slug, phaseBodies);
  // pm-structured-intent-and-refs Phase 1 — reject a spec / phase authored without the plain-language
  // why + what. Same rail as the two gates above (throws before the DB write) so an unreadable spec never
  // lands in `public.specs` / `public.spec_phases`.
  assertEveryNodeHasIntent(
    slug,
    { why: spec.why, what: spec.what },
    spec.phases.map((p) => ({ title: p.title, why: p.why, what: p.what })),
  );
  // pm-structured-intent-and-refs Phase 3 — derive structured checks (caller-provided win, else split
  // the verification blob into bullets) and gate ≥1 per phase. Same fail-loud rail.
  const phaseChecks = spec.phases.map((p) =>
    (p.checks && p.checks.length ? p.checks : parseVerificationBlobToChecks(p.verification)),
  );
  assertEveryPhaseHasChecks(
    slug,
    spec.phases.map((p, i) => ({ title: p.title, checks: phaseChecks[i] })),
  );
  // every-spec-writer-authors-machine-runnable-verifications Phase 1 — the CHOKEPOINT gate. A phase whose
  // structured checks carry only prose / only `needs_human` rows is REJECTED with MissingMachineCheckError.
  // Runs at the single SDK chokepoint so EVERY structured writer (planner, request-fix, box-worker author
  // lanes) inherits the invariant — no path can land a spec whose acceptance criteria the deterministic
  // runner cannot execute. `needs_human` rows may be present as EXTRA but never the sole verification.
  assertEveryPhaseHasMachineCheck(
    slug,
    spec.phases.map((p, i) => ({ title: p.title, checks: phaseChecks[i] })),
  );

  // spec-brain-refs Phase 2 — SUGGEST brain refs at authoring time (structured variant). The `**Brain refs:**`
  // convention lives in the SUMMARY text (per build-spec-materializer Rendered shape); prepend a suggested
  // line to `spec.summary` when the author hasn't already provided one. Scan surface = summary + every phase
  // body so an src/lib reference in a phase's task list still surfaces the right brain page. Best-effort:
  // suggest none is fine (Phase 1's fallback covers it); the author's explicit refs always win.
  {
    const summaryText = spec.summary ?? "";
    const bodyForScan = [summaryText, ...spec.phases.map((p) => p.body ?? "")].join("\n\n");
    // fix-spec-brain-refs — a durable skip marker (either the `<!-- brain-refs: skip -->` comment or
    // an empty `**Brain refs:**` header) anywhere on the scan surface means the author explicitly
    // picked NONE; short-circuit so a subsequent structured re-author never re-injects.
    if (!hasBrainRefsLine(summaryText) && !hasBrainRefsSkip(bodyForScan)) {
      try {
        const refs = deriveSuggestedBrainRefs(bodyForScan);
        if (refs.length) {
          const line = formatBrainRefsLine(refs);
          spec = {
            ...spec,
            summary: summaryText ? `${line}\n\n${summaryText}` : line,
          };
          console.log(
            `[author-spec] ${slug} — suggested Brain refs: ${refs.map((r) => r.wikilink).join(", ")}`,
          );
        }
      } catch { /* best-effort */ }
    }
  }

  try {
    // re-author-re-opens-dismissed: snapshot the PRE-upsert row so we can tell a content-changing re-author
    // from a brand-new spec or a no-op re-author (the re-open decision compares old vs new content). Read is
    // best-effort — a read blip just skips the re-open (the spec still authors).
    let existing: SpecRow | null = null;
    try {
      existing = await getSpec(workspaceId, slug);
    } catch {
      existing = null;
    }
    // Runaway-authoring circuit-breaker: only a BRAND-NEW DERIVATIVE fix spec can trip it (a re-author of an
    // existing slug, a planner milestone parented to a goal, or a human/spec-chat author never does). At the
    // threshold it halts + escalates and returns false — the caller already treats false as "author failed."
    const isDerivativeFix =
      !!opts.repairSignature ||
      !!opts.regressionOfSlug ||
      DERIVATIVE_FIX_SLUG_RE.test(slug) ||
      (typeof spec.parent === "string" && spec.parent.includes("../specs/"));
    if (!existing && isDerivativeFix && (await isRunawayFixAuthoring(workspaceId, slug))) {
      return false;
    }
    // single-source-of-truth: for a goal-bound spec, DERIVE the Parent prose from the bound milestone so it
    // can never drift to a bare-goal (the 2026-07 systematic planner bounce). The milestone_id is the truth;
    // the prose is its projection — the author's parent string is overridden when a milestone is bound.
    if (opts.milestoneId) {
      const derivedParent = await deriveMilestoneParentProse(opts.milestoneId);
      if (derivedParent) spec = { ...spec, parent: derivedParent };
    }
    // improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate Phase 2 — SELF-CORRECT a
    // bare-function parent (matches `functions/{slug}` but no `#anchor`, no `mandate` keyword, no goal
    // ref) BEFORE assertValidParent runs: resolve the function's mandates, pick the best fit for the
    // spec's title+why+what, and rewrite parent + parentKind + parentRef to the specific mandate. So a
    // bare `[[../functions/cs]]` parent no longer bounces — it lands anchored. Skipped when a milestone
    // is bound (the goal path owns the parent) or when the caller already declared a typed mandate/
    // milestone parent (trust the caller). A zero-mandate function still falls through to
    // assertValidParent → InvalidParentError (nothing to anchor to).
    let effectiveParentKind: AuthorSpecOpts["parentKind"] = opts.parentKind ?? null;
    let effectiveParentRef: AuthorSpecOpts["parentRef"] = opts.parentRef ?? null;
    if (
      !opts.milestoneId &&
      effectiveParentKind !== "mandate" &&
      effectiveParentKind !== "milestone"
    ) {
      const anchor = await autoAnchorBareFunctionParent(spec.parent, {
        title: spec.title,
        why: spec.why,
        what: spec.what,
      });
      if (anchor) {
        spec = { ...spec, parent: anchor.parent };
        effectiveParentKind = anchor.parentKind;
        effectiveParentRef = anchor.parentRef;
        if (opts.onAutoAnchor) {
          try { opts.onAutoAnchor(anchor); } catch { /* best-effort — the anchor still applies */ }
        }
        console.log(
          `[author-spec] ${slug} — auto-anchored bare function parent → ${anchor.parentRef} ` +
            `("${anchor.mandate.heading}" mandate)`,
        );
      }
    }
    // one-off-spec-parent: reject a bare-goal parent BEFORE the write (fail-loud, like the Verification/Intent
    // gates) so a one-off spec never lands with a goal parent Vale will bounce forever. Trusts a declared
    // typed parent / bound milestoneId (see assertValidParent).
    assertValidParent(spec.parent, { milestoneId: opts.milestoneId, parentKind: effectiveParentKind });
    // retire-vale-spec-review-becomes-deterministic-authoring-gate Phase 1 — the DETERMINISTIC spec-review
    // gate that replaces the Vale LLM lane. Runs the full mechanical checklist Vale used to run (phase-
    // heading contiguity, Owner resolves to a functions page, Parent resolves via DB lookup, Blocked-by
    // slugs resolve + acyclic, customer_id table companion plan) and throws `SpecReviewGateError` with
    // the exact named failure(s). Runs BEFORE `upsertSpec` so a malformed spec never reaches
    // `public.specs`. See [[spec-review-gate]].
    await assertSpecReviewGate(workspaceId, {
      slug,
      owner: normalizeOwnerSlug(spec.owner),
      parent: spec.parent,
      parent_kind: effectiveParentKind ?? null,
      parent_ref: effectiveParentRef ?? null,
      blocked_by: spec.blocked_by ?? [],
      milestone_id: opts.milestoneId ?? null,
      phases: spec.phases.map((p, i) => ({
        position: i + 1,
        title: p.title,
        body: p.body,
        verification: phaseBodies[i].verification,
      })),
    });
    const phases: SpecPhaseInput[] = spec.phases.map((p, i) => ({
      position: i + 1,
      title: p.title,
      body: p.body,
      // Freshly-authored phases start `planned` (nothing has shipped). pr/merge_sha left undefined so an
      // idempotent re-author after a phase shipped preserves the stamped provenance.
      status: p.status ?? "planned",
      pr: undefined,
      merge_sha: undefined,
      verification: phaseBodies[i].verification,
      // pm-structured-intent-and-refs Phase 1 — persist the per-phase intent columns. The gate above
      // already ensured they're non-empty; here we simply pass them through to the SDK writer.
      why: p.why.trim(),
      what: p.what.trim(),
    }));
    const upsertResult = await upsertSpec(
      workspaceId,
      {
        slug,
        title: spec.title,
        summary: spec.summary,
        owner: normalizeOwnerSlug(spec.owner),
        parent: spec.parent,
        blocked_by: spec.blocked_by ?? [],
        priority: spec.critical ? "critical" : null,
        deferred: intendedStatus === "deferred",
        intended_status: intendedStatus,
        status: opts.status,
        intended_status_set_by: opts.intendedStatusSetBy ?? null,
        repair_signature: opts.repairSignature !== undefined ? opts.repairSignature : null,
        regression_of_slug: opts.regressionOfSlug !== undefined ? opts.regressionOfSlug : null,
        regression_signature: opts.regressionSignature !== undefined ? opts.regressionSignature : null,
        // no-spec-parent — the origin-spec LINK (never a parent). Preserved when omitted.
        related_spec: opts.relatedSpec,
        // pm-structured-intent-and-refs Phase 1 — persist the spec-level intent columns.
        why: spec.why.trim(),
        what: spec.what.trim(),
        // pm-structured-intent-and-refs Phase 2 — typed parent (function|mandate|milestone). Optional at
        // the SDK layer; the structured input carries them when known. Legacy shapes leave them null.
        // improve-tab auto-anchor Phase 2 — when the chokepoint SELF-CORRECTED a bare-function parent
        // above, `effectiveParentKind`/`effectiveParentRef` carry the derived `mandate` / `{fn}#{mandate}`
        // pair (else fall through to the caller's typed values).
        parent_kind: effectiveParentKind ?? null,
        parent_ref: effectiveParentRef ?? null,
        // every-spec-writer-authors-machine-runnable-verifications Phase 2 — persist the OPTIONAL,
        // non-blocking advisory note. Precedence: `opts.humanReview` (planner / director surfaces that
        // hold the note separately from the spec body) beats `spec.human_review` (structured input on
        // the spec itself). `undefined` on both preserves the stored value; explicit `null` clears it;
        // a string writes through. NEVER gated on by fold/promote/spec-check runner.
        human_review:
          opts.humanReview !== undefined ? opts.humanReview
          : spec.human_review !== undefined ? spec.human_review
          : undefined,
        // auto-build-default-on: an autonomously-authored spec auto-builds by DEFAULT — only an EXPLICIT
        // `autoBuild: false` parks it (request-fix + pre-merge-fix opt out deliberately; Pia's planner
        // decomposition + spec-chat + director-authored specs pass nothing → on). Omitting it used to default
        // to `false`, silently parking every authored spec — which broke hands-off autonomy (a greenlit goal's
        // decomposed specs sat forever). `!== false` so `undefined`/`true` → on, only `false` → off.
        auto_build: spec.autoBuild !== false,
        milestone_id: opts.milestoneId ?? null,
      },
      phases,
    );
    // repair-author-write-surface-real-error-not-swallow Phase 2 — READ-AFTER-WRITE. Same guard as the
    // markdown chokepoint: a resolved `upsertSpec` isn't proof the row landed (RLS drop / pool bounce
    // / any silent no-op path). Re-assert the concrete post-condition (row visible via `getSpec`)
    // right at the write point so the caller never enqueues a build for a slug that didn't persist.
    // On miss, throw with the CONCRETE cause so the caller's catch preserves the real message end-to-end.
    const persistedRow = await getSpec(workspaceId, slug);
    if (!persistedRow) {
      throw new AuthorWriteFailedError(
        `authorSpecRowStructured ${slug}: row not visible after upsertSpec — silent no-op write ` +
          `(RLS drop, pool bounce, or an upsert path that swallowed its own error). The spec was ` +
          `never persisted to public.specs; do NOT proceed to enqueue a build for this slug.`,
      );
    }
    // re-author-re-opens-dismissed: if this was a content-changing re-author of an existing spec, re-open it
    // (reset review signals + status=in_review, clear the standing init/groom dismissal) so the corrected
    // content is re-evaluated, never carried under a stale verdict. No-op for a brand-new / no-op re-author.
    await reopenIfReauthoredAndChanged(workspaceId, slug, existing, {
      title: spec.title,
      summary: spec.summary,
      phases: phaseBodies,
    });
    // pm-structured-intent-and-refs Phase 2 — persist structured brain refs. Prefer the caller's
    // explicit `opts.brainRefs`, else derive from the summary + phase bodies via the existing
    // suggester (which is what the pre-Phase-2 shape already wrote onto the summary line). This
    // replaces the row set for the spec so a re-author reflects the current picks. Best-effort.
    try {
      const refs: SpecBrainRefInput[] = [];
      if (opts.brainRefs && opts.brainRefs.length) {
        for (const r of opts.brainRefs) refs.push({ phase_id: r.phase_id ?? null, brain_slug: r.brain_slug });
      } else {
        const scan = [spec.summary ?? "", ...spec.phases.map((p) => p.body)].join("\n\n");
        for (const cand of deriveSuggestedBrainRefs(scan)) {
          // wikilink comes as "../libraries/foo" — strip the leading "../" for the canonical slug.
          const slugStr = cand.wikilink.replace(/^\.\.\//, "");
          refs.push({ phase_id: null, brain_slug: slugStr });
        }
      }
      if (upsertResult?.spec_id) await replaceSpecBrainRefs(upsertResult.spec_id, refs);
    } catch (e) {
      console.warn(
        `[author-spec] ${slug} — spec_brain_refs persist failed (best-effort):`,
        e instanceof Error ? e.message : e,
      );
    }
    // pm-structured-intent-and-refs Phase 3 — persist per-phase structured checks. The chokepoint gate
    // above already ensured each phase yields ≥1; here we write them via `upsertPhaseChecks` per phase.
    try {
      for (let i = 0; i < spec.phases.length; i++) {
        const phaseId = upsertResult?.phase_ids?.[i + 1];
        if (!phaseId) continue;
        await upsertPhaseChecks(phaseId, phaseChecks[i]);
      }
    } catch (e) {
      console.warn(
        `[author-spec] ${slug} — spec_phase_checks persist failed (best-effort):`,
        e instanceof Error ? e.message : e,
      );
    }
    // retire-vale-spec-review-becomes-deterministic-authoring-gate Phase 2 — the reactive
    // `spec-review/spec-mutated` kick to Vale's LLM lane is retired. The deterministic gate
    // ([[spec-review-gate]]) has already run synchronously above; there is no downstream LLM lane
    // to notify. Nothing to send.
    return true;
  } catch (e) {
    // repair-author-write-surface-real-error-not-swallow Phase 2 — RE-THROW the caught error rather
    // than collapsing to `return false`. Every downstream `instanceof MissingVerificationError` /
    // `instanceof MissingIntentError` / `instanceof InvalidParentError` discriminator (request-fix
    // route, agent-grader, triage) survives because we re-throw as-is; only a non-Error is wrapped
    // in `AuthorWriteFailedError` to still surface the message.
    const name = e instanceof Error ? e.name : "Error";
    const msg = errText(e);
    console.warn(`[author-spec] authorSpecRowStructured ${slug} failed: ${name}: ${msg}`);
    if (e instanceof Error) throw e;
    throw new AuthorWriteFailedError(`authorSpecRowStructured ${slug} failed: ${name}: ${msg}`);
  }
}

/**
 * `submitSpec` — the canonical, ergonomic name for authoring a spec into the build pipeline
 * (harden-spec-submission). Identical to `authorSpecRowStructured`: the ONE hardened door every session /
 * agent / script should call to submit a spec. It runs the Verification + Intent + Parent gates and the
 * brain-ref auto-suggester, then writes through `upsertSpec` (which now ALSO self-gates as a floor). Prefer
 * this name in new code and in the [[submit-spec]] skill; `authorSpecRowStructured` remains for existing
 * callers. NEVER call raw `upsertSpec` to author — it throws `UngatedSpecAuthorError` on empty
 * verification/intent by design.
 */
export const submitSpec = authorSpecRowStructured;

// ── retire-md-spec-writers-db-is-sole-spec Phase 3 — markdown-to-structured coercion helper ───────
//
// Every autonomous lane that used to hand `markNewSpecInReview` / `authorSpecRowFromMarkdown` a
// markdown followup body (platform-director's `applyDirectorAuthorFollowup` was the last runtime
// caller) now funnels through the STRUCTURED chokepoint `authorSpecRowStructured`. This helper is
// the ONE deterministic converter that takes an already-validated markdown body (the caller's own
// pre-write shape check — for platform-director that's `validateFollowupSpec`) and returns the
// typed `StructuredSpecInput` shape, WITH a machine-runnable `exec_kind:'tsc'` default check per
// phase so the every-writer-authors-machine-runnable-verifications chokepoint gate passes on the
// first attempt. The prose Verification bullets ride verbatim on the phase's `verification`
// column (human-facing) — only the `checks[]` column drives deterministic execution, and a bare
// `tsc` gate is the safe default every autonomous fix spec already gates on before merge.
export function buildStructuredSpecInputFromMarkdown(
  slug: string,
  markdown: string,
): StructuredSpecInput {
  const card = parseAuthoredSpecMarkdown(slug, markdown);
  const phaseBodies = extractPhaseBodies(markdown);
  const intent = extractIntentHeaders(markdown);
  const specWhy = (intent.why ?? "").trim() ||
    `${card.title} — the plain-language WHY was not supplied on the markdown body; the follow-up spec inherits the parent lane's intent (director-authored follow-up).`;
  const specWhat = (intent.what ?? "").trim() || (card.summary ?? "").trim() ||
    `${card.title} — when this spec ships, the root cause the parent lane surfaced is addressed.`;
  const phases: StructuredPhaseInput[] = card.phases.map((p, i) => {
    const pb = phaseBodies[i];
    const body = (pb?.body ?? "").trim();
    const verification = (pb?.verification ?? "").trim();
    return {
      title: p.title,
      body: body || `${p.title} — body inherited from the follow-up markdown.`,
      verification: verification || `- Repo typechecks clean after this phase lands.`,
      why: specWhy,
      what: specWhat,
      status: p.status as Phase,
      // Default typed machine check — safe across every autonomous fix-spec class (repair/coverage/
      // director-followup), same shape as [[repair-agent]] `derivedDefaultRepairChecks`. Extra
      // prose bullets from the markdown Verification stay on the `verification` column verbatim.
      checks: [
        {
          position: 1,
          description: "Repo typechecks clean (`npx tsc --noEmit`) after this phase lands.",
          kind: "auto",
          exec_kind: "tsc",
          params: null,
        },
      ],
    };
  });
  return {
    title: card.title,
    summary: card.summary || null,
    owner: card.owner ?? "",
    parent: card.parent ?? "",
    blocked_by: (card.blockedBy ?? []).map((b) => b.slug),
    critical: !!card.critical,
    autoBuild: card.autoBuild !== false,
    why: specWhy,
    what: specWhat,
    phases,
  };
}

/**
 * Author / re-author a spec to the DB from its markdown body — the DB-only writer every markdown-holding
 * author surface calls. Idempotent: re-running with the same body produces no material change (UPSERT by
 * `(workspace_id, slug)`, phase replacement by `(spec_id, position)`).
 *
 * `repair-author-write-surface-real-error-not-swallow` Phase 2: FAIL LOUD on every write error — the inner
 * catch re-throws the caught error AS-IS (so downstream `instanceof MissingVerificationError` /
 * `MissingIntentError` / `InvalidParentError` discriminators still work), and a `getSpec` read-after-write
 * throws `AuthorWriteFailedError` when the row is not visible post-upsert (a silent no-op — RLS drop /
 * pool bounce / upsert path that swallowed its own error). The `Promise<boolean>` return is retained for
 * shape compatibility with existing callers but is now effectively `Promise<true>` — every failure THROWS.
 */
export async function authorSpecRowFromMarkdown(
  workspaceId: string,
  slug: string,
  markdown: string,
  intendedStatus: "planned" | "deferred",
  opts: AuthorSpecOpts = {},
): Promise<boolean> {
  // ENFORCEMENT (reject before the DB write): every phase must carry a non-empty Verification AND a
  // non-empty body. This runs OUTSIDE the try/catch below so an untestable OR un-buildable authoring
  // FAILS LOUDLY (throws) rather than being swallowed. `repair-author-write-surface-real-error-not-
  // swallow` Phase 2 aligned the INNER catch to also throw (rather than `return false`) so every
  // author-write failure (structural + raw DB + read-after-write miss) surfaces with a concrete
  // message end-to-end. ~13 specs shipped with empty verification columns because there was no
  // verification gate; db-index-orders shipped a 0-byte body because there was no body gate — both
  // gates now guard the write path.
  const phaseBodies = extractPhaseBodies(markdown);
  assertEveryPhaseHasVerification(slug, phaseBodies);
  // spec-body-never-silently-empty Phase 1 — reject a phase with an empty body (the db-index-orders class).
  assertEveryPhaseHasBody(slug, phaseBodies);
  // every-spec-writer-authors-machine-runnable-verifications Phase 1 — the CHOKEPOINT gate for the markdown
  // author path. Derive each phase's structured checks from its `## Verification` blob and reject the write
  // when no check is machine-runnable. `parseVerificationBlobToChecks` stamps un-typed prose lines with
  // `exec_kind='needs_human'` (the safe deterministic-runner default), so a prose-only markdown authoring
  // fails LOUD with MissingMachineCheckError here — same invariant the structured path enforces below via
  // `assertEveryPhaseHasMachineCheck`. Phase 2 rewrites the writer prompts + submit-spec skill to emit typed
  // checks; Phase 3 backfills existing prose to typed. Until those land, a markdown writer that carries
  // only prose is rejected at the same rail — no writer can land a prose-only spec.
  {
    const mdPhaseChecks = phaseBodies.map((p) => parseVerificationBlobToChecks(p.verification));
    assertEveryPhaseHasMachineCheck(
      slug,
      phaseBodies.map((p, i) => ({ title: p.title, checks: mdPhaseChecks[i] })),
    );
  }

  // spec-brain-refs Phase 2 — SUGGEST brain refs at authoring time. If the incoming markdown has no
  // `**Brain refs:**` line, scan the body for src/ files + tables + wikilinks it already names and
  // propose the top ≤4 as a `**Brain refs:**` line right under the last metadata header. Best-effort:
  // if nothing maps, we suggest none (never break authoring); if the author already picked, we never
  // override (their pick wins). Author-confirmable through the same spec-chat refine loop the rest of
  // the body edits through — a subsequent refine turn can strip/replace the suggested refs.
  const suggested = suggestBrainRefs(markdown);
  if (suggested.refs.length && suggested.body !== markdown) {
    markdown = suggested.body;
    console.log(
      `[author-spec] ${slug} — suggested Brain refs: ${suggested.refs.map((r) => r.wikilink).join(", ")}`,
    );
  }

  try {
    const card = parseAuthoredSpecMarkdown(slug, markdown);
    const regressionHeaders = extractRegressionHeaders(markdown);
    // pm-structured-intent-and-refs Phase 1 — extract plain-language intent headers from the markdown
    // (`**Why:**` / `**What:**`) when present. The markdown path is SOFT: if the surfaces haven't been
    // updated to emit these headers yet the row lands with `why=null` / `what=null` (surfaces migrate
    // incrementally). A single warn line surfaces the gap on the log so we can hunt down un-migrated
    // callers. The structured chokepoint is the HARD gate.
    const intent = extractIntentHeaders(markdown);
    if (!intent.why || !intent.what) {
      console.warn(
        `[author-spec] ${slug} — markdown body has no ` +
          `${!intent.why ? "**Why:**" : ""}${!intent.why && !intent.what ? " / " : ""}${!intent.what ? "**What:**" : ""}` +
          ` header (pm-structured-intent-and-refs Phase 1 — soft warning; will HARD-gate once every surface emits them).`,
      );
    }

    // re-author-re-opens-dismissed: snapshot the PRE-upsert row (best-effort) for the content-changed compare.
    let existing: SpecRow | null = null;
    try {
      existing = await getSpec(workspaceId, slug);
    } catch {
      existing = null;
    }

    // improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate Phase 2 — SELF-CORRECT a
    // bare-function parent BEFORE assertValidParent runs (same behavior as the structured path). The
    // markdown path unwraps `[[…]]` brackets on parse, so `card.parent` reaches us bracket-stripped —
    // `detectBareFunctionParent` matches both forms. Skipped when a milestone is bound OR when the caller
    // already declared a typed mandate/milestone parent.
    let mdEffectiveParentKind: AuthorSpecOpts["parentKind"] = opts.parentKind ?? null;
    let mdEffectiveParentRef: AuthorSpecOpts["parentRef"] = opts.parentRef ?? null;
    let mdParent = card.parent ?? "";
    if (
      !opts.milestoneId &&
      mdEffectiveParentKind !== "mandate" &&
      mdEffectiveParentKind !== "milestone"
    ) {
      const anchor = await autoAnchorBareFunctionParent(mdParent, {
        title: card.title,
        why: intent.why ?? "",
        what: intent.what ?? "",
      });
      if (anchor) {
        mdParent = anchor.parent;
        mdEffectiveParentKind = anchor.parentKind;
        mdEffectiveParentRef = anchor.parentRef;
        if (opts.onAutoAnchor) {
          try { opts.onAutoAnchor(anchor); } catch { /* best-effort — the anchor still applies */ }
        }
        console.log(
          `[author-spec] ${slug} — auto-anchored bare function parent → ${anchor.parentRef} ` +
            `("${anchor.mandate.heading}" mandate)`,
        );
      }
    }
    // one-off-spec-parent: reject a bare-goal parent BEFORE the write (the markdown path never passes a typed
    // parentKind, so this catches a markdown-authored one-off forced onto a bare goal). Thrown → caught below
    // → author returns false (the spec never lands), same as any parse defect on this soft path.
    assertValidParent(mdParent, { milestoneId: opts.milestoneId, parentKind: mdEffectiveParentKind });

    // retire-vale-spec-review-becomes-deterministic-authoring-gate Phase 1 — deterministic spec-review gate
    // for the markdown path. Same checklist as the structured path (phase-heading contiguity, Owner /
    // Parent / Blocked-by resolution, customer_id companion). Runs BEFORE `upsertSpec` so a malformed
    // markdown-authored spec is rejected at the same rail as the shape gates above.
    await assertSpecReviewGate(workspaceId, {
      slug,
      owner: normalizeOwnerSlug(card.owner ?? ""),
      parent: mdParent,
      parent_kind: mdEffectiveParentKind ?? null,
      parent_ref: mdEffectiveParentRef ?? null,
      blocked_by: (card.blockedBy ?? []).map((b) => b.slug),
      milestone_id: opts.milestoneId ?? null,
      phases: card.phases.map((p, i) => ({
        position: i + 1,
        title: p.title,
        body: phaseBodies[i]?.body ?? "",
        verification: phaseBodies[i]?.verification ?? null,
      })),
    });

    const phases: SpecPhaseInput[] = card.phases.map((p, i) => ({
      position: i + 1,
      title: p.title,
      body: phaseBodies[i]?.body ?? "",
      // For a freshly-authored spec every phase starts `planned` (a new spec hasn't shipped anything).
      // The trigger ignores `in_review` for status rollup, and Vale's disposition flips us out of in_review.
      status: p.status as Phase,
      // PASS undefined to PRESERVE existing pr/merge_sha on update (idempotent re-author after a phase
      // already shipped — the build merge hook will have stamped pr/merge_sha, don't blow it away here).
      pr: undefined,
      merge_sha: undefined,
      // Verification is markdown-authoritative (same as body): extractPhaseBodies split the `## Verification`
      // / `### Verification` subsection OUT of the body into this column. Pass an explicit value (string or
      // null) so a re-author reflects the current markdown — never leave the checklist stranded in the body.
      verification: phaseBodies[i]?.verification ?? null,
    }));

    await upsertSpec(
      workspaceId,
      {
        slug,
        title: card.title,
        summary: card.summary || null,
        owner: card.owner ?? "",
        parent: mdParent,
        blocked_by: (card.blockedBy ?? []).map((b) => b.slug),
        priority: card.critical ? "critical" : null,
        deferred: card.status === "deferred",
        intended_status: intendedStatus,
        status: opts.status,
        intended_status_set_by: opts.intendedStatusSetBy ?? null,
        repair_signature: opts.repairSignature !== undefined ? opts.repairSignature : extractRepairSignature(markdown),
        regression_of_slug: opts.regressionOfSlug !== undefined ? opts.regressionOfSlug : regressionHeaders.ofSlug,
        regression_signature: opts.regressionSignature !== undefined ? opts.regressionSignature : regressionHeaders.signature,
        // no-spec-parent — the origin-spec LINK (never a parent): opts win, else parse a `**Related-spec:**`
        // header from the markdown (how the repair agent emits it). `undefined` → PRESERVE on re-author.
        related_spec: opts.relatedSpec !== undefined ? opts.relatedSpec : (extractRelatedSpecHeader(markdown) ?? undefined),
        // pm-structured-intent-and-refs Phase 1 — persist the extracted intent (null when the markdown
        // surface hasn't been migrated yet; the structured chokepoint is HARD-gated).
        why: intent.why,
        what: intent.what,
        // improve-tab auto-anchor Phase 2 — a self-corrected bare-function parent carries the
        // derived `mandate` / `{fn}#{mandate}` pair through to the DB. Otherwise inherits the
        // caller's typed values (else null).
        parent_kind: mdEffectiveParentKind ?? null,
        parent_ref: mdEffectiveParentRef ?? null,
        // every-spec-writer-authors-machine-runnable-verifications Phase 2 — persist the OPTIONAL,
        // non-blocking founder-facing advisory note. Precedence: `opts.humanReview` wins (explicit
        // caller decision, including `null` to CLEAR); else parse the `**Human-review:**` header from
        // the markdown body (how a submit-spec / director surface would emit it). `undefined` in
        // both places → preserve the stored value. NEVER gated on.
        human_review:
          opts.humanReview !== undefined ? opts.humanReview
          : (extractHumanReviewHeader(markdown) ?? undefined),
        // auto-build-default-on: HONOR the markdown parser's documented contract — "**Auto-build:** absent = on;
        // only off/no/false/manual/disabled flips it false" (brain-roadmap.ts ~307). `card.autoBuild` is
        // `undefined` when no line is present, which the parser MEANS as "on" — so `!== false` (undefined → on,
        // explicit off → off). The old `=== true` inverted this: a spec with no Auto-build line (the common case)
        // landed `auto_build=false`, silently parking every markdown-authored spec (spec-chat / repair / director).
        auto_build: card.autoBuild !== false,
        milestone_id: opts.milestoneId ?? null,
      },
      phases,
    );
    // repair-author-write-surface-real-error-not-swallow Phase 2 — READ-AFTER-WRITE. A "silent no-op"
    // upsert (RLS drop, pooler bounce eating the DDL, a fire-and-forget insert that swallowed its own
    // error, a race that no-op'd) resolves without throwing yet leaves `public.specs` empty for this
    // slug. Before Phase 2 the caller (`markNewSpecInReview` → `groupOrAuthorRepairSpec`) would
    // treat the resolved upsert as success, enqueue a `repair_build` for a slug that had NEVER
    // persisted, and the parked-router at the build claim-gate would silently dismiss the missing
    // row as noise — the "16 phantom-completed repairs in 7 days" trap. Confirming the row is
    // actually visible after the write is the same guard shape the coaching mandate cites
    // (compare-and-set / verify-after-mutate): don't trust the coarse `resolved without throwing`
    // proxy; assert the concrete post-condition the caller depends on (row exists) at the write
    // point. On miss, throw `AuthorWriteFailedError` with the CONCRETE cause so the caller surfaces
    // "row not visible after write" onto the parked repair job's `error` column instead of the
    // generic "silent author-write fallout" fallback.
    const persisted = await getSpec(workspaceId, slug);
    if (!persisted) {
      throw new AuthorWriteFailedError(
        `authorSpecRowFromMarkdown ${slug}: row not visible after upsertSpec — silent no-op write ` +
          `(RLS drop, pool bounce, or an upsert path that swallowed its own error). The spec was ` +
          `never persisted to public.specs; do NOT proceed to enqueue a build for this slug.`,
      );
    }
    // re-author-re-opens-dismissed: content-changing re-author of an existing spec → re-open (reset review
    // signals + status=in_review, clear standing init/groom dismissal). `phaseBodies` is the same
    // {title,body,verification} shape the structured path compares; map the parsed phase titles in.
    await reopenIfReauthoredAndChanged(workspaceId, slug, existing, {
      title: card.title,
      summary: card.summary || null,
      phases: card.phases.map((p, i) => ({
        title: p.title,
        body: phaseBodies[i]?.body ?? "",
        verification: phaseBodies[i]?.verification ?? null,
      })),
    });
    // retire-vale-spec-review-becomes-deterministic-authoring-gate Phase 2 — the reactive kick to Vale's
    // LLM lane is retired. The deterministic gate ([[spec-review-gate]]) has already run synchronously
    // above; no downstream LLM lane to notify.
    return true;
  } catch (e) {
    // repair-author-write-surface-real-error-not-swallow Phase 2 — RE-THROW the caught error rather
    // than collapsing to `return false`. Before Phase 2 this catch swallowed a raw DB/upsert error
    // (or an assertValidParent / MissingIntentError / any thrown-inside-the-try error) into a bare
    // `false` return, which the caller (`markNewSpecInReview`) turned into a generic
    // "silent author-write fallout" AuthorWriteFailedError with no diagnosis. Now the concrete
    // error class + message survives to the caller (→ repair-agent → parked job.error), so an
    // operator (and Ada's supervision lane) reads the REAL cause instead of the fallback string.
    // console.warn stays for the box operator's tail; the throw is the load-bearing signal.
    const name = e instanceof Error ? e.name : "Error";
    const msg = errText(e);
    console.warn(`[author-spec] authorSpecRowFromMarkdown ${slug} failed: ${name}: ${msg}`);
    // If it was already an Error, re-throw AS-IS so downstream `instanceof MissingVerificationError`
    // / `instanceof MissingIntentError` etc. checks (e.g. request-fix/route.ts) still discriminate.
    // Only wrap when we caught a non-Error (very rare).
    if (e instanceof Error) throw e;
    throw new AuthorWriteFailedError(`authorSpecRowFromMarkdown ${slug} failed: ${name}: ${msg}`);
  }
}

// Re-export `toDbStatus` for callers that pre-compute a status (e.g. a fix-spec lane that knows the spec is
// `planned`, not the default `in_review`).
export { toDbStatus };
