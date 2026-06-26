/**
 * author-spec — the single chokepoint every spec-author surface goes through to write the spec body to
 * the DB ([[../tables/specs]] + [[../tables/spec_phases]]) in addition to the legacy
 * `docs/brain/specs/{slug}.md` commit on `main` (spec-authoring-writes-db-and-worker-materialize Phase 1).
 *
 * Dual-write during the transition: the author surface (planner, director-coach, triage, regression,
 * spec-chat, Vale-fix, db-health, coverage-register, repair, security, migration-fix, storefront-optimizer,
 * developer-message-center, director split lanes) STILL commits the .md to `main` (readers haven't cut over
 * yet — [[../libraries/brain-roadmap]] `parseSpec` is still served from disk), AND it now records the row
 * here so the future DB-resident surfaces (build materializer, fold-from-DB, db-driven readers) line up.
 * The mirror lane (Phase 4) will replace the inline .md commit with a worker step driven off the DB write
 * once readers cut over ([[spec-readers-from-db-retire-parser]]).
 *
 * Best-effort: a DB upsert failure logs a warning but never blocks the upstream commit (the markdown stays
 * canonical for the markdown-first readers). Same defensive posture as `markNewSpecInReview` had on
 * spec_card_state.
 */
import { parseSpec, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { upsertSpec, type SpecPhaseInput, type SpecStatus as DbSpecStatus } from "@/lib/specs-table";

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
 *  whole-spec column — fall back to `planned`. `folded` is reachable only via the fold worker. */
function toDbStatus(s: SpecStatus): DbSpecStatus {
  if (s === "rejected") return "planned";
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
}

/**
 * Author / re-author a spec to the DB from its markdown body — the dual-write writer every author surface
 * calls AFTER its existing .md commit succeeds. Idempotent: re-running with the same body produces no
 * material change (UPSERT by `(workspace_id, slug)`, phase replacement by `(spec_id, position)`).
 *
 * Best-effort: a failure logs a warning and returns `false` but does NOT throw — the upstream .md commit
 * is the canonical source until [[spec-readers-from-db-retire-parser]] flips readers over.
 */
export async function authorSpecRowFromMarkdown(
  workspaceId: string,
  slug: string,
  markdown: string,
  intendedStatus: "planned" | "deferred",
  opts: AuthorSpecOpts = {},
): Promise<boolean> {
  try {
    const card = parseSpec(slug, markdown);
    const phaseBodies = extractPhaseBodies(markdown);
    const regressionHeaders = extractRegressionHeaders(markdown);

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
        auto_build: card.autoBuild === true,
        milestone_id: null,
      },
      phases,
    );
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
