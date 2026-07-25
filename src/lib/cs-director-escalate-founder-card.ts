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
  /**
   * Phase 2 — June's SUGGESTED remedy for the CEO to approve/adjust in one read. Loose shape
   * mirroring RemedyPlan (`kind` + `summary`) but a SUGGESTION, not for auto-execution — the CEO
   * still owns the hard call. When absent/empty, the card body renders an explicit "CEO to decide
   * the action" line so the surface stays consistent and never reads as a bare "needs human review".
   */
  recommendedRemedy?: Record<string, unknown> | null;
  /**
   * june-does-the-in-leash-part-before-escalating-the-residue Phase 1 — the compact outcome of
   * the IN-LEASH partial remedy the executor fired BEFORE minting this card. When present, the
   * card body prepends a "June already did:" section so the founder sees settled work as settled
   * (not re-decided) and the escalation reads only about the RESIDUE. `null` on a plain escalation
   * (June carried no `remedy`). See [[../../docs/brain/libraries/cs-director]] for the flow.
   */
  partialRemedyOutcome?: PartialRemedyCardInput | null;
}

/**
 * The subset of `PartialRemedyOutcome` (from src/lib/cs-director.ts) the card body needs to
 * render the "June already did" section. Kept local so this module stays pure with no import
 * from cs-director.ts (avoids a circular type dep — the runtime shape is duck-typed).
 */
export interface PartialRemedyCardInput {
  status:
    | "landed"
    | "failed"
    | "loyalty_refused"
    | "threshold_gated"
    | "malformed"
    | "delivery_failed";
  landed_actions: string[];
  failed_actions: Array<{ label: string; error?: string }>;
  planned_action_types: string[];
  message_delivered: boolean;
  refusal_reason?: string | null;
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
    /**
     * Phase 2 — the STRUCTURED suggested remedy carried verbatim from the verdict, so a downstream
     * approver / bounce-back handler can pick it up without re-parsing the human body text. Null
     * when June did not provide a recommendation (distinct from omitted — the caller can tell
     * "absent" from "unread").
     */
    recommended_remedy: Record<string, unknown> | null;
    /**
     * june-does-the-in-leash-part-before-escalating-the-residue Phase 1 — the compact outcome of
     * the in-leash partial remedy the executor fired BEFORE this card was minted. `null` when the
     * verdict carried no `remedy` (the escalation has no partial pre-work). The runner and any
     * downstream approver/replay can read the settled work here without re-parsing the body.
     */
    partial_remedy_outcome: PartialRemedyCardInput | null;
  };
}

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
 * Render June's suggested remedy as a one-line summary — the surface the CEO reads on the card
 * body. Mirrors `cs-director-verdict-note.ts` `summarizeRemedy` on shape (`kind`/`type`/`action` +
 * `summary`/`description`/`reason`) so June's verdict-emit conventions land the same across the
 * internal note and the CEO card. When the recommendation is absent OR the object carries no
 * usable kind + summary, the fallback names the founder as the decider explicitly — never a bare
 * "needs human review" (the Phase-2 verification's exact negation).
 */
export function summarizeRecommendedRemedy(remedy: Record<string, unknown> | null | undefined): string {
  if (!remedy) return "(none — CEO to decide the action)";
  const kind = pickString(remedy, "kind") ?? pickString(remedy, "type") ?? pickString(remedy, "action");
  const summary = pickString(remedy, "summary") ?? pickString(remedy, "description") ?? pickString(remedy, "reason");
  if (kind && summary) return `${kind}: ${summary}`;
  if (summary) return summary;
  if (kind) return kind;
  return "(none — CEO to decide the action)";
}

/**
 * Render the "June already did" section for the CEO card body from a `PartialRemedyOutcome`. Pure.
 * The returned string is a single labeled line ("Already done: ..." / "Attempted but failed: ..." /
 * "Proposed partial remedy REFUSED: ...") — the founder reads one line to see the settled work
 * OR why the partial did not land, without opening the ticket.
 *
 * On the `landed` status the line names the exact action types the executor verified so the CEO
 * sees what changed on the customer's account. On `failed` it names both what landed AND what
 * failed so the residue is complete. On the refusal statuses (loyalty/threshold/malformed) the
 * line names the reason so the founder knows June considered the partial but the rails refused it.
 */
export function summarizePartialRemedyForCard(outcome: PartialRemedyCardInput): string {
  const list = (arr: string[]) => (arr.length > 0 ? arr.join(", ") : "(none)");
  switch (outcome.status) {
    case "landed": {
      const actions = outcome.landed_actions.length > 0 ? outcome.landed_actions : outcome.planned_action_types;
      const suffix = outcome.message_delivered ? " · customer already notified" : "";
      return `Already done by June: [${list(actions)}]${suffix}.`;
    }
    case "failed": {
      const failedTxt = outcome.failed_actions
        .map((f) => (f.error ? `${f.label} — ${f.error}` : f.label))
        .join("; ");
      return `Attempted but the executor escalated — landed: [${list(outcome.landed_actions)}]; failed: [${failedTxt || "(unspecified)"}]. No customer message sent.`;
    }
    case "loyalty_refused":
      return `Proposed partial remedy [${list(outcome.planned_action_types)}] REFUSED by the loyalty ceiling — nothing fired.`;
    case "threshold_gated":
      return `Proposed partial remedy [${list(outcome.planned_action_types)}] EXCEEDS the founder-approval threshold — nothing fired (you decide the whole ticket).`;
    case "delivery_failed":
      return `Actions landed [${list(outcome.landed_actions)}] but customer message delivery failed — the customer has NOT been notified yet.`;
    case "malformed":
    default:
      return `Proposed partial remedy could not be executed (${outcome.refusal_reason ?? "malformed"}) — nothing fired.`;
  }
}

/**
 * Pure builder — returns the `dashboard_notifications` row shape (title/body/link/metadata) for the
 * CEO inbox card an escalate_founder verdict mints. Deterministic in its inputs — the same inputs
 * always yield the same title/body/metadata, so the test suite can exercise it end-to-end.
 *
 * Title is the human-facing chip in the approvals feed. Body carries the reasoning so the CEO can
 * read the finding without opening the ticket, and the deep-link takes them to the ticket for the
 * full context.
 *
 * june-does-the-in-leash-part-before-escalating-the-residue Phase 1: when `partialRemedyOutcome`
 * is present, the body prepends "Already done by June: ..." so the founder sees SETTLED WORK as
 * settled (not re-decided) and the escalation reads only about the RESIDUE. A `failed` /
 * `delivery_failed` outcome renders as "Attempted but…" so the founder is not misled that the
 * partial landed cleanly.
 */
export function buildEscalateFounderCard(input: EscalateFounderCardInput): EscalateFounderCardRow {
  const {
    ticketId,
    reasoning,
    jobId,
    triageRunId,
    blackSwanClass,
    blackSwanSource,
    recommendedRemedy,
    partialRemedyOutcome,
  } = input;
  const normalizedReason = normalizeReasoning(reasoning);
  const link = `/dashboard/tickets/${ticketId}`;

  const classSuffix = blackSwanClass && blackSwanClass !== "unspecified" ? ` (${blackSwanClass})` : "";
  const title = `CS Director — escalate to founder${classSuffix}`.slice(0, 200);

  // Phase 2 — labeled body: Diagnosis (June's finding) + Recommended remedy (June's suggested
  // action, or an explicit "CEO to decide" line when absent). The founder can approve/adjust in
  // one read rather than re-investigating; the surface stays the same shape whether or not June
  // proposed a concrete remedy (never a bare "needs human review").
  //
  // june-does-the-in-leash Phase 1 — when June also fired an in-leash partial remedy before
  // escalating, prepend a labeled "Already done by June" line so the founder sees settled work as
  // settled and the "Diagnosis:" / "Recommended remedy:" lines read as the RESIDUE.
  const alreadyDoneLine = partialRemedyOutcome
    ? `Already done by June: ${summarizePartialRemedyForCard(partialRemedyOutcome)}`
    : null;
  const diagnosisLine = `Diagnosis: ${normalizedReason}`;
  const remedyLine = `Recommended remedy: ${summarizeRecommendedRemedy(recommendedRemedy)}`;
  const bodyLines = [alreadyDoneLine, diagnosisLine, remedyLine].filter((v): v is string => v !== null);
  const body = bodyLines.join("\n").slice(0, 4000);

  // The structured recommendation persists on metadata verbatim so a downstream approver can
  // pick it up without re-parsing the body — null (not omitted) so the caller can distinguish
  // "absent" from "unread".
  const recommendedRemedyMeta =
    recommendedRemedy && Object.keys(recommendedRemedy).length > 0 ? recommendedRemedy : null;

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
      recommended_remedy: recommendedRemedyMeta,
      partial_remedy_outcome: partialRemedyOutcome ?? null,
    },
  };
}
