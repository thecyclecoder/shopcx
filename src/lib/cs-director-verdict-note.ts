/**
 * cs-director-verdict-note — Pure builder for the INTERNAL system note that Phase 1 of
 * cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict writes on the ticket
 * after June (the CS Director) rules on an escalated ticket.
 *
 * Before this shipped, a `decision='author_spec'` verdict left the ticket open + escalated + note-
 * less — the CS agent looking at the ticket queue could not tell it had already been reviewed.
 * The note this builder produces is the audit-visible receipt of the review that renders in the
 * ticket thread as an internal (non-customer) message via the same `ticket_messages` write path
 * every other internal note in the pipeline uses (visibility='internal', author_type='system').
 *
 * Kept pure (no DB, no imports from the runtime worker) so `runCsDirectorCallJob` can call it +
 * pass the string body to a straight `ticket_messages` insert, and so a unit test can exercise
 * every verdict shape (see cs-director-verdict-note.test.ts). The concrete output line encodes
 * the per-verdict handoff the spec calls out:
 *   author_spec       → the authored spec slug (+ title when present)
 *   approve_remedy    → a one-line summary of the RemedyPlan (kind + human summary)
 *   escalate_founder  → the reasoning itself IS the founder-escalation reason (per spec)
 *
 * See docs/brain/specs/cs-director-call-closes-the-ticket-loop-note-and-resolution-per-verdict.md
 * Phase 1 verification + [[../../docs/brain/libraries/cs-director.md]] loop-closure contract.
 */

export type CsDirectorDecision = "approve_remedy" | "author_spec" | "escalate_founder" | "close_no_action";

/**
 * Phase 1 of cs-director-spec-claim-must-match-the-actual-write — the OUTCOME `handleAuthorSpec`
 * returned for an `author_spec` verdict, threaded through to the note builder so the receipt names
 * the write, not the claim. Before this shipped, `summarizeSpecSeed` rendered
 * `Authored spec: {slug}` off `verdict.spec_seed` (the LLM's claim) with no reference to the
 * executor's result — a phantom spec (ticket 2b7ea029) still read as authored on the ticket thread.
 *
 *  - `specWritten: true` + `spec_slug` (the slug the specs SDK actually landed, which the handler
 *    may have normalized away from June's seed) → the note renders the CONFIRMED-write line.
 *  - `specWritten: false` + `reason` (`spec_seed_missing_*`, `ticket_id_unresolved`,
 *    `author_spec_write_returned_false`, `author_spec_threw`, `handler_threw`) → the note renders
 *    an explicit FAILED line naming the reason, so the audit trail never reads as if the spec
 *    landed.
 *  - `undefined` (`author_spec` decision but no outcome threaded) → the builder falls back to the
 *    legacy claim-only line so a stale caller doesn't crash. This shape MUST NOT be introduced by
 *    the shipped call site — it exists only for back-compat with an unrelated test that predates
 *    the outcome argument.
 */
export interface CsDirectorAuthorSpecOutcome {
  /**
   * True iff the specs SDK confirmed the write (`applyBoxCsDirectorCall` returned ok + no
   * needs_attention). Named `specWritten` — not `ok` — because the whole point of Phase 1 is that
   * the receipt line must key off "did the spec ACTUALLY get written?" and NOT off a coarser
   * proxy ("did the handler return without throwing?"). Kept in sync with the same-named field on
   * the transition's [[./cs-director-ticket-transition]] `CsDirectorAuthorSpecOutcome` so the
   * runner derives ONE outcome and threads it into BOTH the note builder + the transition gate.
   */
  specWritten: boolean;
  spec_slug?: string;
  reason?: string;
}

export interface CsDirectorNoteInput {
  decision: CsDirectorDecision;
  reasoning: string;
  remedy?: Record<string, unknown> | null;
  spec_seed?: Record<string, unknown> | null;
  /**
   * Phase 1 of cs-director-spec-claim-must-match-the-actual-write — the outcome of the
   * `handleAuthorSpec` executor call. Only meaningful for `decision='author_spec'`; ignored for the
   * other decisions.
   */
  author_outcome?: CsDirectorAuthorSpecOutcome | null;
  /**
   * Phase 3 of escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation —
   * June's OPTIONAL suggested remedy on an `escalate_founder` verdict (RemedyPlan-shaped: kind +
   * summary). When present, the note surfaces it verbatim as a "Recommended remedy: …" line so the
   * ticket thread carries the SAME recommendation the CEO card carries — the CS agent reading the
   * ticket sees the concrete recommended action, not just the reasoning. Distinct from `remedy`
   * (which is the AUTO-APPLY plan on `approve_remedy`).
   */
  recommended_remedy?: Record<string, unknown> | null;
}

const DECISION_LABEL: Record<CsDirectorDecision, string> = {
  approve_remedy: "approve_remedy",
  author_spec: "author_spec",
  escalate_founder: "escalate_founder",
  close_no_action: "close_no_action",
};

function normalizeReasoning(raw: string): string {
  const s = (raw || "").trim();
  return s.length > 0 ? s : "(no reasoning recorded)";
}

function pickString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!source) return null;
  const v = source[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Phase 1 of cs-director-spec-claim-must-match-the-actual-write — render the author_spec line from
 * the executor's OUTCOME, not from the LLM's claim.
 *
 *  - Confirmed write (`author_outcome.specWritten === true` + `spec_slug`): render `Authored
 *    spec: {slug}` using the slug the specs SDK actually landed. The SDK may have normalized
 *    June's seed slug, so we PREFER the outcome's slug over the seed's slug. When the seed
 *    carried a title we still surface it for readability (title is descriptive metadata, not the
 *    identifying key).
 *  - Failed write (`author_outcome.specWritten === false`): render `author_spec FAILED ({reason})
 *    — no spec was written`. NEVER surface a slug on a failed write — the whole point of Phase 1
 *    is that a receipt can never assert a spec landed when none did (the ticket 2b7ea029
 *    regression class).
 *  - Missing outcome (undefined author_outcome — the legacy shape a pre-Phase-1 caller could pass):
 *    fall back to the claim-only line so a stale test caller doesn't crash. The shipped call site
 *    ALWAYS threads the outcome; this path exists only for back-compat with unit tests that
 *    exercise the note builder without an executor.
 */
function summarizeSpecSeed(
  seed: Record<string, unknown> | null | undefined,
  outcome: CsDirectorAuthorSpecOutcome | null | undefined,
): string {
  if (outcome && outcome.specWritten === false) {
    const reason = outcome.reason && outcome.reason.trim().length > 0 ? outcome.reason.trim() : "unknown_reason";
    return `author_spec FAILED (${reason}) — no spec was written`;
  }
  const outcomeSlug = outcome && outcome.specWritten === true && typeof outcome.spec_slug === "string" && outcome.spec_slug.trim().length > 0
    ? outcome.spec_slug.trim()
    : null;
  const seedSlug = pickString(seed, "slug");
  const slug = outcomeSlug ?? seedSlug;
  const title = pickString(seed, "title");
  if (slug && title) return `Authored spec: ${slug} — "${title}"`;
  if (slug) return `Authored spec: ${slug}`;
  if (title) return `Authored spec: "${title}"`;
  return "Authored spec: (slug missing — see director_activity for the verdict)";
}

function summarizeRemedy(remedy: Record<string, unknown> | null | undefined): string {
  const kind = pickString(remedy, "kind") ?? pickString(remedy, "type") ?? pickString(remedy, "action");
  const summary = pickString(remedy, "summary") ?? pickString(remedy, "description") ?? pickString(remedy, "reason");
  if (kind && summary) return `Approved remedy (${kind}): ${summary}`;
  if (kind) return `Approved remedy: ${kind}`;
  if (summary) return `Approved remedy: ${summary}`;
  return "Approved remedy: (see director_activity for the RemedyPlan)";
}

function summarizeEscalateFounder(reasoning: string): string {
  return `Escalated to CEO for hard call: ${reasoning}`;
}

/**
 * Phase 3 — render June's SUGGESTED remedy line for an escalate_founder note. Returns null when
 * the recommendation is absent OR the object carries no usable kind + summary (an empty object is
 * "no recommendation", not a fallback line — keeps the ticket thread quiet when June intentionally
 * omitted a concrete recommendation). Kept structurally aligned with `summarizeRecommendedRemedy`
 * on the CEO card builder so the ticket thread and the CEO card carry the same shape.
 */
function summarizeRecommendedRemedy(remedy: Record<string, unknown> | null | undefined): string | null {
  if (!remedy) return null;
  const kind = pickString(remedy, "kind") ?? pickString(remedy, "type") ?? pickString(remedy, "action");
  const summary = pickString(remedy, "summary") ?? pickString(remedy, "description") ?? pickString(remedy, "reason");
  if (kind && summary) return `Recommended remedy (${kind}): ${summary}`;
  if (summary) return `Recommended remedy: ${summary}`;
  if (kind) return `Recommended remedy: ${kind}`;
  return null;
}

/**
 * Compose the internal-note body for a CS-Director verdict. The line shape is stable so the CS
 * agent can eyeball a ticket thread and immediately see who ruled, what the decision was, why,
 * and the concrete output. The Phase-1 verification bullet asserts each verdict shape lands.
 */
export function buildCsDirectorVerdictNote(verdict: CsDirectorNoteInput): string {
  const reasoning = normalizeReasoning(verdict.reasoning);
  const header = `[CS Director review] Reviewer: June (CS Director) · Decision: ${DECISION_LABEL[verdict.decision]}`;
  const reasoningLine = `Reasoning: ${reasoning}`;
  const lines: string[] = [header, reasoningLine];
  switch (verdict.decision) {
    case "author_spec":
      lines.push(summarizeSpecSeed(verdict.spec_seed, verdict.author_outcome));
      break;
    case "approve_remedy":
      lines.push(summarizeRemedy(verdict.remedy));
      break;
    case "escalate_founder": {
      lines.push(summarizeEscalateFounder(reasoning));
      // Phase 3 — surface June's suggested remedy on the ticket thread so it carries the SAME
      // recommendation the CEO card carries. Silent when June did not name one (the note stays
      // Phase-1-shaped for a policy/storyline judgment call).
      const recommendedLine = summarizeRecommendedRemedy(verdict.recommended_remedy);
      if (recommendedLine) lines.push(recommendedLine);
      break;
    }
    case "close_no_action":
      lines.push("Outcome: No action needed — handling was already correct and there is no in-leash remedy or founder decision to make. Closed + de-escalated (no founder page).");
      break;
  }
  return lines.join("\n");
}
