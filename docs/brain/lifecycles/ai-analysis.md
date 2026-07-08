# AI analysis + proposed rules lifecycle

The quality-control loop on the AI agent itself. Nightly cron analyzes recent tickets, surfaces patterns where the AI got it wrong or near-missed, generates **proposed sonnet_prompts rules** for a human to review, and tracks knowledge gaps that drive the research-and-heal pipeline.

This is the "make the AI smarter over time without manually tuning prompts" feedback loop.

## Phases

```
recent tickets → grader → ticket_analyses
                            ↓
                       low-score patterns
                            ↓
                  proposed sonnet_prompts (status='proposed')
                            ↓
                 human review at /dashboard/ai-analysis
                            ↓
                approve → status='approved' → orchestrator picks up live
                reject → status='rejected' → not used
```

### Phase 1 — per-ticket analysis

[[../inngest/ticket-analysis-cron]] (`*/30`, per closed AI ticket — replaced the old nightly batch, removed 2026-07-07):
- Selects recent closed tickets (e.g. last 24h, AI-handled, customer rated low OR AI sentiment classified as failure).
- Pulls full conversation + Sonnet decision JSON + customer outcome.
- Runs each through a grader prompt (configured per workspace at [[../tables/grader_prompts]]) using Claude Opus.
- Writes [[../tables/ticket_analyses]] with grade, summary, suggested fix.

### Phase 2 — pattern surfacing

The same nightly job aggregates the analyses:
- Tickets graded < threshold cluster by `ai_detected_intent` + sentiment + outcome.
- Recurring patterns ("AI promised refunds it didn't process," "AI gave wrong restock date") get distinct rows in [[../tables/daily_analysis_reports]].
- Each report row links back to the contributing ticket_analyses.

### Phase 3 — propose sonnet_prompts rules

For each surfaced pattern, the job generates a candidate fix as a [[../tables/sonnet_prompts]] row:
- `category='rule'` (the AI rule layer)
- `status='proposed'`
- `enabled=false`
- `proposed_by='ai_analysis'`
- `proposed_from_pattern_id` linking to the daily_analysis_report

Per [[../customer-voice]] § Three layers, proposed rules sit at the *scenario rules* layer — they don't change voice ([[../customer-voice]]) or policy ([[../tables/policies]]).

### Phase 4 — human review

At `/dashboard/ai-analysis` ([[../dashboard/ai-analysis]]):
- Owner / admin sees the daily report card grid.
- Clicking through to a report shows the contributing tickets with grader notes + the proposed rule.
- Admin can **Approve** (sets `status='approved'` + `enabled=true` → orchestrator picks it up on next request) or **Reject** (sets `status='rejected'`).
- Approved rules show up in the live sonnet_prompts query that the orchestrator reads at runtime.

### Phase 5 — knowledge gaps

When the AI hits a question it can't answer from the knowledge base (KB miss in `get_product_knowledge`), it logs a row to [[../tables/knowledge_gaps]] with the question + customer message + ticket context. The same dashboard surfaces these for review — admin can either:
- Author a new [[../tables/knowledge_base]] article that closes the gap
- Add a new [[../tables/sonnet_prompts]] rule covering the scenario

Both paths get tracked; the gap row gets marked closed once content lands.

### Phase 6 — research-and-heal trigger

Tickets where the grader flagged a *specific verifiable claim mismatch* (e.g. AI said "I paused your subscription" but the sub status is still active) get a heal recipe candidate. See [[research-and-heal]] for the Phase-1 manual heal recipes (`verify_subscription_changes`, `verify_coupon_promises`, `verify_grandfathered_pricing`).

## Status / open work

**Shipped:** Grader pipeline, ticket_analyses + daily_analysis_reports tables, dashboard surface, propose-rule mechanism, knowledge_gaps logging.

**Known gaps / not yet shipped:**
- **AI nightly analysis cron is PAUSED** as of 2026-04-28. The pipeline is intact but the cron isn't firing. Specific tickets surfaced before the pause (Ivan, Faye, Gail; Sarah's $13.96; `jo:*` tag conflict on the journey-outcome rule) are still open follow-ups. See memory `project_ai_analysis_apr28`.
- Research-and-heal **Phase 2** (auto-heal via allowlist) — not shipped. See [[research-and-heal]].

**Recent activity:**
- No active commits — pipeline is paused.
- The ticket **Improve** tab is now **box-hosted** ([[../specs/box-ticket-improve]] · [[../tables/ticket_improve_chats]]): a ticket-bound, resumable Max `claude -p` session that investigates read-only and proposes an approval-gated plan. It can **re-score this ticket** on approval (a `rescore` plan action → `analyzeTicket(ticketId, "manual")` → a fresh `ticket_analyses` row) and propose `sonnet_prompts`/`grader_prompts` rules + ticket-derived analyzer-fix specs (owner=cs). Owned by [[../functions/cs]].
- **Improve has full orchestrator parity** (`improve-orchestrator-action-parity`, shipped 2026-06-20): a new `orchestrator_action` plan kind drives the EXACT production executor — [[../orchestrator-tools]]'s `executeSonnetDecision` — so an approved Improve plan can **launch a journey/playbook/workflow/macro, escalate, or fire any direct action**, with production-correct portal/email/chat/sms delivery (the [[../libraries/ticket-delivery]] sink fixes the old `send_message` gap that never emailed portal customers). The hand-rolled direct-action cases in [[../libraries/improve-actions]] now delegate to the shared `directActionHandlers` registry — one customer-action code path, no drift. Same path `scripts/apply-coupon-via-executor.ts` drives one-off. See [[../libraries/improve-plan-executor]].
- **Grader judges against the data the AI actually had — not gaps in the analyzer's own surface** ([[../specs/cora-grades-against-ai-data-surface-no-false-fabrication-on-unseen-facts]]): the SURFACE-BOUNDED GRADING rule in `buildGraderSystemPrompt` triages every AI claim into CONTRADICTS-the-surface (real `inaccuracy`, HARD CAPS apply), CONFIRMED (not an issue), or ABSENT-from-the-surface (`unverified_from_surface` — a low-confidence note that does NOT count as a fabrication, does NOT cap the score, and does NOT trigger escalation). `applySeverityActions` additionally short-circuits the reopen/escalate on a positively-closed ticket whose sole flag is `unverified_from_surface`, so no unverified-only resolved ticket ever fires a [[../inngest/triage-escalations]] `cs-director-call`. See [[../libraries/ticket-analyzer]] for the code path.
- **Escalation triage now runs on the box** ([[../specs/box-escalation-triage]], shipped 2026-06-20): an hourly **solver/skeptic** sweep ([[../inngest/triage-escalations]] cron enqueues it) double-checks every routine-owned escalated ticket on Max. When a ticket was **mis-escalated** (`escalation_false_positive`), the quorum materializes an **analyzer-fix spec** — `docs/brain/specs/{slug}.md`, owner=cs, `Derived-from-ticket:` ref, targeting `src/lib/ticket-analyzer.ts` (severity thresholds / `SEVERE_ISSUE_TYPES` / `CUSTOMER_ESCALATION_KEYWORDS` / grader prompt) — committed to main and surfaced on [[../dashboard/roadmap]] to commission a build, **not** a customer reply. Genuine issues become `agent_todos`; recurring gaps become proposed `sonnet_prompts`; every run is audited in [[../tables/triage_runs]].

**Open questions:**
- When does the nightly cron resume? Resuming without clearing the Apr-28-era backlog will surface the same patterns over and over.
- The `jo:*` tag conflict between the journey-outcome rule (`jo:positive`) and the cancel-outcome rule needs resolution before the rule layer is trusted again.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/inngest/ticket-analysis-cron.ts` | Per-ticket analysis fn |
| `src/lib/inngest/daily-analysis-reports-cron.ts` | Pattern aggregation |
| `src/lib/grader.ts` | Grader prompt assembly |
| `src/app/dashboard/ai-analysis/page.tsx` | Dashboard list view |
| `src/app/dashboard/ai-analysis/[id]/page.tsx` | Per-report detail view + approve/reject buttons |
| `src/app/api/workspaces/[id]/sonnet-prompts/[promptId]/route.ts` | Approve / reject endpoint |

## Related

[[ai-multi-turn]] · [[research-and-heal]] · [[ticket-lifecycle]] · [[../customer-voice]] · [[../orchestrator-tools]] · [[../tables/ticket_analyses]] · [[../tables/daily_analysis_reports]] · [[../tables/sonnet_prompts]] · [[../tables/knowledge_gaps]] · [[../tables/grader_prompts]] · [[../dashboard/ai-analysis]]
