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
- **Cora selects on the DETERMINISTIC `sol_handled_at` signal (not a live Direction row).** The exported pure predicate `passesCoraSelectionGate(ticket, now, latestJuneDecidedAt)` — pinned in `src/lib/inngest/ticket-analysis-cron.gate.test.ts` — takes the four columns Cora needs (`closed_at`, `last_analyzed_at`, `sol_handled_at`, + the June-decided lookup) and applies the founder's stated logic: **Sol responded · ticket closed · closed ≥30 min · not already graded this cycle · June has not already decided this cycle**. The `find-tickets` step filters `.not("sol_handled_at", "is", null)` at the source (paired with `.eq("status", "closed")` + `.contains("tags", ["ai"])` + `.eq("analyzer_locked", false)` + the 30-min `settleCutoff` on `closed_at`). Per-handling-cycle dedup compares `last_analyzed_at` vs `sol_handled_at`; the June-decided guard compares `director_activity.created_at` (max per ticket via the workspace-scoped batch) vs `sol_handled_at`. **`sol_handled_at` is the harness-stamped signal, not an AI mid-session write.** The worker's `runTicketHandleJob` writes it on the box session's terminal COMPLETED state via `createAdminClient()`, so an in-session `writeDirection` failure (observed on the first ~6-7 Sol-handled tickets under a DB outage) no longer hides "Sol responded" from Cora's feeder. The `'ai'` tag stays as a coarse cheap pre-filter; `sol_handled_at` is the authoritative Sol-handled signal. See [[../specs/cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence]] Phase 2.


## Downstream events sent

_None._

## Tables written

- [[../tables/tickets]]

## Tables read (not written)



---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
