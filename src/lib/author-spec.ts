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

/**
 * Per-phase BODY text extractor (sibling to parseSpec which only captures title + status). The body is the
 * markdown between this phase heading and the NEXT phase heading / next H2 section — preserved as-is so the
 * builder can replay the spec from the DB without losing structure. Position is 1-indexed and lines up with
 * `parseSpec().phases[i]`. Returns the same shape the backfill script produces.
 */
export function extractPhaseBodies(raw: string): { title: string; body: string }[] {
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
    const out: { title: string; body: string }[] = [];
    for (let p = 0; p < headings.length; p++) {
      const start = headings[p].lineIdx + 1;
      let end = lines.length;
      for (let k = start; k < end; k++) {
        if (isPhaseHeading(lines[k])) { end = k; break; }
        if (/^##\s+/.test(lines[k]) && !/^##\s+Phases?\s*$/i.test(lines[k])) { end = k; break; }
      }
      out.push({ title: cleanInline(headings[p].rawTitle), body: lines.slice(start, end).join("\n").trim() });
    }
    return out;
  }

  // Pass 2: bullet-style phases under `## Phases`.
  const out: { title: string; body: string }[] = [];
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
    out.push({ title: cleanInline(bm[1]), body: bm[1].trim() });
  }
  return out;
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
