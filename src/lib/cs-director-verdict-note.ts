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

export type CsDirectorDecision = "approve_remedy" | "author_spec" | "escalate_founder";

export interface CsDirectorNoteInput {
  decision: CsDirectorDecision;
  reasoning: string;
  remedy?: Record<string, unknown> | null;
  spec_seed?: Record<string, unknown> | null;
}

const DECISION_LABEL: Record<CsDirectorDecision, string> = {
  approve_remedy: "approve_remedy",
  author_spec: "author_spec",
  escalate_founder: "escalate_founder",
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

function summarizeSpecSeed(seed: Record<string, unknown> | null | undefined): string {
  const slug = pickString(seed, "slug");
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
 * Compose the internal-note body for a CS-Director verdict. The line shape is stable so the CS
 * agent can eyeball a ticket thread and immediately see who ruled, what the decision was, why,
 * and the concrete output. The Phase-1 verification bullet asserts each verdict shape lands.
 */
export function buildCsDirectorVerdictNote(verdict: CsDirectorNoteInput): string {
  const reasoning = normalizeReasoning(verdict.reasoning);
  const header = `[CS Director review] Reviewer: June (CS Director) · Decision: ${DECISION_LABEL[verdict.decision]}`;
  const reasoningLine = `Reasoning: ${reasoning}`;
  let outputLine: string;
  switch (verdict.decision) {
    case "author_spec":
      outputLine = summarizeSpecSeed(verdict.spec_seed);
      break;
    case "approve_remedy":
      outputLine = summarizeRemedy(verdict.remedy);
      break;
    case "escalate_founder":
      outputLine = summarizeEscalateFounder(reasoning);
      break;
  }
  return [header, reasoningLine, outputLine].join("\n");
}
