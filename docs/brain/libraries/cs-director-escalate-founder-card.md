# libraries/cs-director-escalate-founder-card

The **pure builder** for the CEO inbox card (dashboard_notification) that Phase 1 of [[../specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation]] mints when the CS Director (June) returns an `escalate_founder` verdict on an escalated ticket.

**File:** `src/lib/cs-director-escalate-founder-card.ts`

## What it does

Composes the `agent_approval_request` dashboard_notification that reaches the CEO inbox when an escalate_founder verdict is issued. Before this shipped, the worker's escalate_founder branch only paged the CEO for verdicts the black-swan classifier flagged (fraud / chargeback storm / systemic outage) — every other escalate_founder verdict was appended to the weekly cs-director digest storyline. That left legitimate hard calls (e.g., a real overcharge on a grandfathered subscription, a stuck refund on a billable card) with NO CEO card at all — the ticket sat open + escalated with no owner and the escalation reached no one. The Phase-1 contract is now: EVERY escalate_founder verdict mints this card, routed to the CEO, referencing the ticket + June's reasoning.

The card carries two labeled sections:
- **Diagnosis:** June's 2-4 sentence finding (the concrete issue)
- **Recommended remedy:** June's suggested action (kind + summary), or an explicit "CEO to decide" line when absent

The structure mirrors the internal ticket note (`cs-director-verdict-note`) so the ticket thread and CEO card carry the SAME diagnosis + recommendation — a CS agent scanning the ticket sees what the founder sees.

## Exports

- **`buildEscalateFounderCard(input: EscalateFounderCardInput): EscalateFounderCardRow`** — pure function that composes the dashboard_notifications row shape (title/body/link/metadata). Takes the ticket ID, June's reasoning, the cs-director-call job ID, optional black-swan classification, and Phase 2's optional recommended remedy. Returns the formatted card in dashboard_notifications shape.
- **`summarizeRecommendedRemedy(remedy?: Record<string, unknown>): string`** — helper that renders the remedy as a one-line summary for the card body, mirroring the internal-note rendering. When absent/incomplete, returns "(none — CEO to decide the action)" explicitly — never a bare "needs human review".
- **`EscalateFounderCardInput`** — interface for the input shape (ticketId, reasoning, jobId, optional triageRunId, optional blackSwanClass/blackSwanSource, optional Phase 2 recommendedRemedy).
- **`EscalateFounderCardRow`** — interface for the returned dashboard_notifications shape (title/body/link/metadata).

## How it's used

**Caller:** `scripts/builder-worker.ts` `runCsDirectorCallJob` — after the director's verdict is audited to `director_activity`, the runner calls `buildEscalateFounderCard(verdict)` and passes the result to a `dashboard_notifications` insert. The write path is `{type:'agent_approval_request', title, body, link, metadata, …}`.

The card metadata includes:
- `routed_to_function: 'ceo'` — routes to the CEO inbox
- `escalation_kind: 'cs_director_escalate_founder'` — identifies the card type
- `escalation_reason` — June's reasoning (trimmed, verbatim)
- `recommended_remedy` — Phase 2's structured suggestion (null when absent) so a downstream approver can pick it up without re-parsing the body
- `agent_job_id` — cs-director-call job ID so the approvals-feed enrichment can join to the audit trail

## Gotchas

- **Pure / test-friendly.** The function takes no DB or runtime context — `runCsDirectorCallJob` handles the `dashboard_notifications` write, and unit tests (`cs-director-escalate-founder-card.test.ts`) exercise every field independently.
- **Remedy summary normalization.** If the recommendedRemedy is absent, incomplete, or carries no usable `kind`/`summary`/`type`/`action` fields, the card body renders an explicit "(none — CEO to decide the action)" line — never a bare "needs human review". This mirrors the Phase 2 verification requirement: the CEO card ALWAYS names whether or not June proposed a concrete action.
- **Reasoning normalization.** If reasoning is empty or whitespace-only, it normalizes to "(no reasoning recorded)" so the card never shows a blank diagnosis line.
- **Same shape as other CEO escalations.** The card shape matches the `agent_approval_request` surface every other escalate verdict in the app uses (author-spec, spec-drift, fleet-spend-governor, bounce re-escalation). `buildApprovalsFeed` reads this exact shape into its escalated-set — the CEO reading the approvals feed sees the card alongside every other approval, with a deep-link back to the ticket.

## Related

[[cs-director]] · [[cs-director-verdict-note]] · [[cs-director-ticket-transition]] · [[../tables/dashboard_notifications]] · [[../tables/director_activity]]
