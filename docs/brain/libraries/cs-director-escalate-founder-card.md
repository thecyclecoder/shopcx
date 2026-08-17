# libraries/cs-director-escalate-founder-card

The **pure builder** for the CEO inbox card (dashboard_notification) that Phase 1 of [[../specs/escalate-founder-reliably-creates-the-ceo-inbox-card-with-diagnosis-and-recommendation]] mints when the CS Director (June) returns an `escalate_founder` verdict on an escalated ticket.

**File:** `src/lib/cs-director-escalate-founder-card.ts`

## What it does

Composes the `agent_approval_request` dashboard_notification that reaches the CEO inbox when an escalate_founder verdict is issued. Before this shipped, the worker's escalate_founder branch only paged the CEO for verdicts the black-swan classifier flagged (fraud / chargeback storm / systemic outage) — every other escalate_founder verdict was appended to the weekly cs-director digest storyline. That left legitimate hard calls (e.g., a real overcharge on a grandfathered subscription, a stuck refund on a billable card) with NO CEO card at all — the ticket sat open + escalated with no owner and the escalation reached no one. The Phase-1 contract is now: EVERY escalate_founder verdict mints this card, routed to the CEO, referencing the ticket + June's reasoning.

The card carries up to three labeled sections:
- **Already done by June:** (optional, [[../specs/june-does-the-in-leash-part-before-escalating-the-residue]] Phase 1) — the compact outcome of the in-leash partial remedy the executor fired BEFORE the card was minted. Names WHICH action types landed / whether the customer was notified / whether the executor refused the partial on the loyalty or money-threshold rails. Omitted when the verdict carried no `remedy`.
- **Diagnosis:** June's 2-4 sentence finding (the concrete issue)
- **Recommended remedy:** June's suggested action (kind + summary), or an explicit "CEO to decide" line when absent

The structure mirrors the internal ticket note (`cs-director-verdict-note`) so the ticket thread and CEO card carry the SAME diagnosis + recommendation — a CS agent scanning the ticket sees what the founder sees.

The "Already done by June" line is the anti-Goodhart guard for the escalate path: without it, the founder re-decides settled work (a $15 refund June already landed reads as an open item), and June's incentive on a partly-out-of-leash ticket collapses back to "do nothing and hand the whole thing to the CEO." With it, an escalation reads only about the RESIDUE.

## Exports

- **`buildEscalateFounderCard(input: EscalateFounderCardInput): EscalateFounderCardRow`** — pure function that composes the dashboard_notifications row shape (title/body/link/metadata). Takes the ticket ID, June's reasoning, the cs-director-call job ID, optional black-swan classification, Phase 2's optional recommended remedy, and Phase 1 of `june-does-the-in-leash-part`'s optional `partialRemedyOutcome`. Returns the formatted card in dashboard_notifications shape.
- **`escalateFounderDedupeKey(ticketId): string`** → `cs-director-founder:{ticketId}` — the ONE-OPEN-CARD-PER-TICKET key (the CEO-inbox signal-to-noise hot fix, 2026-08-11). Exported so the runner's insert site and `reconcileStaleParkCards`'s Family 1d agree on the key without re-deriving the string.
- **`summarizeRecommendedRemedy(remedy?: Record<string, unknown>): string`** — helper that renders the remedy as a one-line summary for the card body, mirroring the internal-note rendering. When absent/incomplete, returns "(none — CEO to decide the action)" explicitly — never a bare "needs human review".
- **`summarizePartialRemedyForCard(outcome: PartialRemedyCardInput): string`** — helper that renders the in-leash partial remedy's outcome as the "Already done by June" line. Distinguishes `landed` / `failed` / `loyalty_refused` / `threshold_gated` / `delivery_failed` / `malformed` so the founder never reads a failed partial as settled work.
- **`EscalateFounderCardInput`** — interface for the input shape (ticketId, reasoning, jobId, optional triageRunId, optional blackSwanClass/blackSwanSource, optional Phase 2 recommendedRemedy, optional partialRemedyOutcome).
- **`PartialRemedyCardInput`** — the subset of `PartialRemedyOutcome` (from `src/lib/cs-director.ts`) the card body needs. Kept local so this module has no import from cs-director.ts (avoids a circular type dep).
- **`EscalateFounderCardRow`** — interface for the returned dashboard_notifications shape (title/body/link/metadata). Metadata carries `partial_remedy_outcome` verbatim so a downstream approver/replay can read the settled work without re-parsing the body.

## How it's used

**Caller:** `scripts/builder-worker.ts` `runCsDirectorCallJob` — after the director's verdict is audited to `director_activity`, the runner calls `buildEscalateFounderCard(verdict)` and passes the result to a `dashboard_notifications` insert. The write path is `{type:'agent_approval_request', title, body, link, metadata, …}`.

The card metadata includes:
- `routed_to_function: 'ceo'` — routes to the CEO inbox
- `escalation_kind: 'cs_director_escalate_founder'` — identifies the card type
- `dedupe_key: 'cs-director-founder:{ticketId}'` — **ONE OPEN CARD PER TICKET** (the CEO-inbox signal-to-noise hot fix, 2026-08-11). Keyed on the **ticket**, not the job: [[../inngest/founder-escalation-stale-recheck]] re-enqueues a fresh `cs-director-call` every `STALE_FOUNDER_ESCALATION_HOURS` (48h) for a founder-escalated ticket with no founder action, so pre-fix ONE unresolved ticket minted a NEW CEO card every 48h — on 2026-08-11 the same customer's already-settled refund question held two cards (16h + 18h old). With the key present the card falls under the `dashboard_notifications_dedupe_key_open_uniq` partial index, so the re-mint is a **benign 23505** the runner logs as "already open for ticket …" (explicitly NOT the "escalation reached no one" error path — the card IS up and waiting)
- `escalation_reason` — June's reasoning (trimmed, verbatim)
- `recommended_remedy` — Phase 2's structured suggestion (null when absent) so a downstream approver can pick it up without re-parsing the body
- `agent_job_id` — cs-director-call job ID so the approvals-feed enrichment can join to the audit trail
- `partial_remedy_outcome` — Phase 1 of [[../specs/june-does-the-in-leash-part-before-escalating-the-residue]]. The compact outcome (status + landed_actions + failed_actions + planned_action_types + message_delivered + refusal_reason) of the in-leash actions the executor fired BEFORE minting the card. Null when the verdict carried no `remedy`.
- `retire_when: { kind: 'ticket_terminal', ticket_id }` ([[../specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]] Phase 1) — a self-heal descriptor the [[escalation-retirement-sweep]] reads on each pass. Carried unconditionally since `ticket_id` is a load-bearing input to every founder escalation — when the linked ticket reaches `status='closed'`, the card automatically retires with the evidence recorded.

## Gotchas

- **Pure / test-friendly.** The function takes no DB or runtime context — `runCsDirectorCallJob` handles the `dashboard_notifications` write, and unit tests (`cs-director-escalate-founder-card.test.ts`) exercise every field independently.
- **Remedy summary normalization.** If the recommendedRemedy is absent, incomplete, or carries no usable `kind`/`summary`/`type`/`action` fields, the card body renders an explicit "(none — CEO to decide the action)" line — never a bare "needs human review". This mirrors the Phase 2 verification requirement: the CEO card ALWAYS names whether or not June proposed a concrete action.
- **Reasoning normalization.** If reasoning is empty or whitespace-only, it normalizes to "(no reasoning recorded)" so the card never shows a blank diagnosis line.
- **Same shape as other CEO escalations.** The card shape matches the `agent_approval_request` surface every other escalate verdict in the app uses (author-spec, spec-drift, fleet-spend-governor, bounce re-escalation). `buildApprovalsFeed` reads this exact shape into its escalated-set — the CEO reading the approvals feed sees the card alongside every other approval, with a deep-link back to the ticket.
- **The "Already done" line describes SETTLED WORK, not a proposal.** When `partialRemedyOutcome.status` is `landed`, the actions listed were verified by the executor + delivered to the customer (when a message was authored). A `failed` / `delivery_failed` / `loyalty_refused` / `threshold_gated` outcome renders as "Attempted but…" / "Proposed partial remedy REFUSED …" so the founder is not misled that a partial that didn't land had. If the runner ever renders the "Already done" line from a stale value (e.g., a card mint before the executor returns), that is a WRITE-ORDER bug in the runner — the card is designed to reflect the compact outcome the runner already has in hand.

## Related

[[cs-director]] · [[cs-director-verdict-note]] · [[cs-director-ticket-transition]] · [[../tables/dashboard_notifications]] · [[../tables/director_activity]] · [[escalation-recheck]] · [[escalation-retirement-sweep]]
