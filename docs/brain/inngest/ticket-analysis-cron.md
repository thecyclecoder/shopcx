# inngest/ticket-analysis-cron

Nightly cron that runs `ticket-analyzer.ts` over recent tickets → `ticket_analyses`.

**File:** `src/lib/inngest/ticket-analysis-cron.ts`

## Functions

### `ticket-analysis-cron`
- **Trigger:** cron `*/30 * * * *`
- **Retries:** 3 (in-run infra resilience)
- **Outage park-and-drain:** the grader in [[../libraries/ticket-analyzer]] now **throws** on a Claude failure instead of returning `grader_http_*`. The per-ticket step catches a retryable dependency error (`isRetryableThrownError`, [[../libraries/anthropic-retry]]) and **defers** the ticket — leaves `last_analyzed_at` untouched (counted as `deferred`, not `skipped`) so the next */30 tick re-grades it on recovery. A non-dependency (logic) error stays swallowed-and-marked so one bad ticket can't wedge the batch. ([[../specs/agent-outage-resilience]] Phase 1.)
- **Control Tower heartbeat:** calls `emitCronHeartbeat("ticket-analysis-cron", …)` at the END of **every** run — including the no-tickets idle path (`if (!tickets.length)`). Required because `*/30` against a 90-min liveness window means a few consecutive empty runs would otherwise emit no `loop_heartbeats` row and `control-tower-monitor` would false-flag the healthy quiet cron as dead (signature `loop:ticket-analysis-cron`). Mirrors the empty-path heartbeat in [[ticket-csat]], [[deliver-pending-send]], [[abandoned-cart]]. See [[../libraries/control-tower]].
- **`ai:ticket-analyzer` feeder heartbeat (per handled ticket):** the per-ticket for-loop calls `analyzeTicket(t.id, "auto_close")` from [[../libraries/ticket-analyzer]] — NOT the raw `enqueueTicketAnalyzeJob` — so `analyzeTicket`'s finally block emits one `ai:ticket-analyzer` inline-agent heartbeat per enqueue attempt (`ok:true` on a queued enqueue, `ok:false` on an `enqueue_failed` result / thrown exception). This is the feeder-liveness beat the Control Tower registry's `ai:ticket-analyzer` tile watches for its "liveness-when-work-exists" assertion. The grader (`agent:ticket-analyze`) beats separately from its own box lane; going through `analyzeTicket` keeps one authoritative source for the feeder beat instead of forking the convention across the cron and rescore paths. Skip-reason handling + `last_analyzed_at` stamp-on-slip inside the cron are unchanged — they operate on the returned `AnalyzeResult`, which `analyzeTicket` returns verbatim from `enqueueTicketAnalyzeJob`.
- **`analyzer_locked` exclusion at the source.** The `find-tickets` step filters `.eq("analyzer_locked", false)` in the initial select, so a human's veto ("Lock from analyzer / Approve handling", or the auto-set on human close+unescalate of a previously-escalated ticket) survives an `updated_at` bump — a new tag, an audit note, or any other write can no longer re-trip the close → analyze → reopen → close loop. Paired with the `applySeverityActions` hard-return in [[../libraries/ticket-analyzer]] (checked BEFORE `forceEscalate` so severe-issue and threat-keyword overrides can't punch through) and the analyzer-inner skip that stamps `last_analyzed_at` if a lock lands between SELECT and grade. Non-propagating on merge. Phase 2 of `docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md`.


## Downstream events sent

_None._

## Tables written

- [[../tables/tickets]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
