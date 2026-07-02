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
 * so an untestable spec never reaches `public.spec_phases`. A genuine DB/upsert error is best-effort (logged,
 * returns false) per the historical defensive posture.
 */
import { parseSpec, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { suggestBrainRefs, hasBrainRefsLine, hasBrainRefsSkip, deriveSuggestedBrainRefs, formatBrainRefsLine } from "@/lib/brain-ref-suggest";
import { getSpec, upsertSpec, type SpecPhaseInput, type SpecStatus as DbSpecStatus, type SpecRow } from "@/lib/specs-table";
import { inngest } from "@/lib/inngest/client";

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
  /** Optional: who set the intended_status (the author surface — `planner`, `director-coach`, etc.). */
  intendedStatusSetBy?: string | null;
  /** Optional: bind the authored spec to a goal milestone (`goal_milestones.id`). The goal planner passes
   *  the milestone the proposed spec attaches under so the goal→milestone→spec link is made AT author time
   *  (db-driven; no separate `attachSpecToMilestone` round-trip). Omit / null for a standalone spec. */
  milestoneId?: string | null;
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
    await upsertSpec(
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
        // pm-structured-intent-and-refs Phase 1 — persist the spec-level intent columns.
        why: spec.why.trim(),
        what: spec.what.trim(),
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
    // re-author-re-opens-dismissed: if this was a content-changing re-author of an existing spec, re-open it
    // (reset review signals + status=in_review, clear the standing init/groom dismissal) so the corrected
    // content is re-evaluated, never carried under a stale verdict. No-op for a brand-new / no-op re-author.
    await reopenIfReauthoredAndChanged(workspaceId, slug, existing, {
      title: spec.title,
      summary: spec.summary,
      phases: phaseBodies,
    });
    // vale-reactive-spec-review Phase 2: fire-and-forget kick Vale on any authoring chokepoint (a fresh
    // spec always lands in `in_review`; a re-author already re-opens through the writer above). The
    // consumer routes through the SAME gated `enqueueSpecReviewIfDue`, so a re-author of already-passed
    // content that leaves `vale_pass=true` no-ops for free (no Max session). Errors swallowed — the 15-min
    // cron backstop covers a dropped send.
    void inngest
      .send({ name: "spec-review/spec-mutated", data: { workspace_id: workspaceId } })
      .catch(() => {});
    return true;
  } catch (e) {
    console.warn(
      `[author-spec] authorSpecRowStructured ${slug} failed:`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/**
 * Author / re-author a spec to the DB from its markdown body — the DB-only writer every markdown-holding
 * author surface calls. Idempotent: re-running with the same body produces no material change (UPSERT by
 * `(workspace_id, slug)`, phase replacement by `(spec_id, position)`).
 *
 * Best-effort on the DB write: a failure logs a warning and returns `false`. The Verification gate is a HARD
 * error (throws) before the write so an untestable spec never lands in `public.spec_phases`.
 */
export async function authorSpecRowFromMarkdown(
  workspaceId: string,
  slug: string,
  markdown: string,
  intendedStatus: "planned" | "deferred",
  opts: AuthorSpecOpts = {},
): Promise<boolean> {
  // ENFORCEMENT (reject before the DB write): every phase must carry a non-empty Verification AND a
  // non-empty body. This runs OUTSIDE the best-effort try/catch below so an untestable OR un-buildable
  // authoring FAILS LOUDLY (throws) rather than being swallowed into a `false` return — a bad spec must
  // never reach public.spec_phases. A genuine DB/upsert error stays best-effort (returns false, logged);
  // only these structural defects are hard errors. ~13 specs shipped with empty verification columns
  // because there was no verification gate; db-index-orders shipped a 0-byte body because there was no
  // body gate — both gates now guard the write path.
  const phaseBodies = extractPhaseBodies(markdown);
  assertEveryPhaseHasVerification(slug, phaseBodies);
  // spec-body-never-silently-empty Phase 1 — reject a phase with an empty body (the db-index-orders class).
  assertEveryPhaseHasBody(slug, phaseBodies);

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
    const card = parseSpec(slug, markdown);
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
        parent: card.parent ?? "",
        blocked_by: (card.blockedBy ?? []).map((b) => b.slug),
        priority: card.critical ? "critical" : null,
        deferred: card.status === "deferred",
        intended_status: intendedStatus,
        status: opts.status,
        intended_status_set_by: opts.intendedStatusSetBy ?? null,
        repair_signature: opts.repairSignature !== undefined ? opts.repairSignature : extractRepairSignature(markdown),
        regression_of_slug: opts.regressionOfSlug !== undefined ? opts.regressionOfSlug : regressionHeaders.ofSlug,
        regression_signature: opts.regressionSignature !== undefined ? opts.regressionSignature : regressionHeaders.signature,
        // pm-structured-intent-and-refs Phase 1 — persist the extracted intent (null when the markdown
        // surface hasn't been migrated yet; the structured chokepoint is HARD-gated).
        why: intent.why,
        what: intent.what,
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
    // vale-reactive-spec-review Phase 2: fire-and-forget kick Vale on any authoring chokepoint (same
    // rationale as the structured path — the gated helper no-ops if the current content already carries
    // vale_pass=true). Errors swallowed — the 15-min cron backstop covers a dropped send.
    void inngest
      .send({ name: "spec-review/spec-mutated", data: { workspace_id: workspaceId } })
      .catch(() => {});
    return true;
  } catch (e) {
    console.warn(
      `[author-spec] authorSpecRowFromMarkdown ${slug} failed:`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

// Re-export `toDbStatus` for callers that pre-compute a status (e.g. a fix-spec lane that knows the spec is
// `planned`, not the default `in_review`).
export { toDbStatus };
