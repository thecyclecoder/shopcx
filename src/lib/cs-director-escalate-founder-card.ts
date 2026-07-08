/**
 * cs-director-escalate-founder-card — Pure builder for the CEO inbox card that
 * `runCsDirectorCallJob` (scripts/builder-worker.ts) mints when June (the CS Director) returns a
 * `decision='escalate_founder'` verdict on an escalated ticket.
 *
 * Before this shipped (escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation
 * Phase 1), the worker's escalate_founder branch only paged the CEO for verdicts the black-swan
 * classifier flagged (fraud / chargeback storm / systemic outage) — every other escalate_founder
 * verdict was appended to the weekly cs-director digest storyline. That left legitimate hard
 * calls (a real overcharge on a grandfathered sub, a stuck refund on a billable card, …) with NO
 * CEO card at all — the ticket sat open + escalated with no owner and the escalation reached no
 * one. The Phase-1 contract is now: EVERY escalate_founder verdict mints an `agent_approval_request`
 * dashboard_notification routed to the CEO, referencing the ticket + June's reasoning.
 *
 * Shape: the same `dashboard_notifications` `agent_approval_request` surface every other
 * escalate_founder card in the app uses (author-spec.ts:979 runaway-authoring, spec-drift.ts:1401
 * reverse-drift, fleet-spend-governor.ts spend breach, builder-worker.ts:6921 bounce re-escalation).
 * `buildApprovalsFeed` (src/lib/agents/approvals-feed.ts:220) reads exactly this shape into its
 * escalated-set — a CEO reading the approvals feed sees the card in the same list as every other
 * approval.
 *
 * Kept pure (no DB, no imports from the runtime worker) so the worker can call it + pass the row
 * shape to a straight `dashboard_notifications` insert, and a unit test can exercise every field
 * without a Supabase mock. Reads-only from the verdict — the caller is responsible for the write.
 *
 * See docs/brain/specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation.md
 * and [[../../docs/brain/libraries/cs-director.md]] for the escalate_founder → CEO-card contract.
 */

export interface EscalateFounderCardInput {
  /** The ticket that June ruled `escalate_founder` on — the card body links back to it. */
  ticketId: string;
  /** June's 2-4 sentence "why" for the escalation — carried on the card body + escalation_reason. */
  reasoning: string;
  /** cs-director-call agent_jobs row that produced the verdict — links the card to the audit trail. */
  jobId: string;
  /** triage_runs row id when the call went through the triage audit slice (null when absent). */
  triageRunId?: string | null;
  /** black-swan classification of the verdict (null when the classifier didn't flag it). */
  blackSwanClass?: string | null;
  /** how the black-swan class was derived — 'verdict_metadata' | 'keyword_default' | null. */
  blackSwanSource?: string | null;
}

export interface EscalateFounderCardRow {
  title: string;
  body: string;
  link: string;
  metadata: {
    routed_to_function: "ceo";
    raised_by_function: "cs";
    escalated_by_director: "cs";
    escalation_kind: "cs_director_escalate_founder";
    /** buildApprovalsFeed reads this as the card summary — carries June's reasoning verbatim (trimmed). */
    escalation_reason: string;
    ticket_id: string;
    cs_director_call_job_id: string;
    triage_run_id: string | null;
    black_swan_class: string | null;
    black_swan_source: string | null;
    deep_link: string;
    autonomous: boolean;
    /** so the approvals-feed enrichment can join to the cs-director-call agent_jobs row. */
    agent_job_id: string;
  };
}

function normalizeReasoning(raw: string): string {
  const s = (raw || "").trim();
  return s.length > 0 ? s : "(no reasoning recorded)";
}

/**
 * Pure builder — returns the `dashboard_notifications` row shape (title/body/link/metadata) for the
 * CEO inbox card an escalate_founder verdict mints. Deterministic in its inputs — the same inputs
 * always yield the same title/body/metadata, so the test suite can exercise it end-to-end.
 *
 * Title is the human-facing chip in the approvals feed. Body carries the reasoning so the CEO can
 * read the finding without opening the ticket, and the deep-link takes them to the ticket for the
 * full context.
 */
export function buildEscalateFounderCard(input: EscalateFounderCardInput): EscalateFounderCardRow {
  const { ticketId, reasoning, jobId, triageRunId, blackSwanClass, blackSwanSource } = input;
  const normalizedReason = normalizeReasoning(reasoning);
  const link = `/dashboard/tickets/${ticketId}`;

  const classSuffix = blackSwanClass && blackSwanClass !== "unspecified" ? ` (${blackSwanClass})` : "";
  const title = `CS Director — escalate to founder${classSuffix}`.slice(0, 200);
  const body = normalizedReason.slice(0, 4000);

  return {
    title,
    body,
    link,
    metadata: {
      routed_to_function: "ceo",
      raised_by_function: "cs",
      escalated_by_director: "cs",
      escalation_kind: "cs_director_escalate_founder",
      escalation_reason: normalizedReason.slice(0, 2000),
      ticket_id: ticketId,
      cs_director_call_job_id: jobId,
      triage_run_id: triageRunId ?? null,
      black_swan_class: blackSwanClass ?? null,
      black_swan_source: blackSwanSource ?? null,
      deep_link: link,
      autonomous: true,
      agent_job_id: jobId,
    },
  };
}
