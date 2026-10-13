# inngest/ticket-response-sla-watchdog

The **30-minute response SLA guarantee** ([[../specs/every-inbound-handled-within-30-min]] Phase 1). Every failure mode on 2026-10-07 (tickets 09f7257a / 2acc8634 / 668bc5c8 / Sanja's edf7331f) ended the same way: a Sol or Sonnet turn failed or produced no reply, and **nothing owned the ticket after that**. The [[unanswered-inbound-backstop-cron]] handles the LOST-INGEST class (a `ticket/inbound-message` event that was dropped), but it does NOT fire when a dispatch landed, the handler claimed, and the turn FAILED — the stamp is cleared, no customer-facing reply was sent, and the ticket just sits open until a human notices.

This watchdog is the catch-net for THAT class. Every 5 minutes it finds open tickets whose newest inbound customer message has sat past the response SLA with no outbound external reply, no reply queued, and no live claim on it (not already escalated, no inflight `ticket-handle`/`cs-director-call` job), and **enqueues ONE `cs-director-call` agent_jobs row for June**. June rules before the founder is paged — the spec forbids escalating directly to the founder from this surface.

**Phase 3 — running playbooks survive, stalled ones get caught** ([[../specs/playbooks-survive-merge-guard-teasers-watchdog-catches-stalls]]). The watchdog used to blanket-exempt every ticket carrying an `active_playbook_id` (both in the candidate query and the per-ticket re-read), so a playbook that STALLED mid-flow was hidden from the SLA forever. That exemption is removed: playbook-active tickets are now EVALUATED. A running playbook is skipped only while it is **healthy** — a reply landed after the customer's last message, a send is pending, OR a `ticket-handle`/`cs-director-call` job is in flight (the new `hasInflightJob` term, widened from `cs-director-call`-only to also cover the `ticket-handle` job a playbook turn runs as). A **stalled** playbook (customer waiting 30+ min with none of those) is routed to June with the playbook name + step named in the brief and the internal note — and the watchdog **never clears or mutates playbook state**, it only routes.

**File:** `src/lib/inngest/ticket-response-sla-watchdog.ts`

## Function

### `ticket-response-sla-watchdog`

- **Trigger:** cron `*/5 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`
- **Owner:** `cs` (June)
- **Registered:** [[../libraries/control-tower]] `MONITORED_LOOPS` · `livenessWindowMs = 20 min`

### Flow

1. **Find candidates.** `tickets` where `status = 'open'`, `merged_into IS NULL`, `escalated_at IS NULL`, `assigned_to IS NULL`, and `last_customer_reply_at` is inside `[now - SLA_MAX_AGE_MS, now - TICKET_RESPONSE_SLA_MS]`. Ordered oldest-first, capped at `BATCH = 25`. (Phase 3: the `active_playbook_id IS NULL` filter is GONE — playbook-active tickets are evaluated; `playbook_step` is also selected for the brief.)
2. **Inflight guard.** Skip any ticket already carrying a queued / claimed / building / needs_input `ticket-handle` OR `cs-director-call` job. The two kinds use different `spec_slug` shapes: `cs-director-call` uses the bare ticket id; `ticket-handle` uses `ticket-handle-${ticketId.slice(0,8)}` (set at the first-touch enqueue in `unified-ticket-handler.ts`). The guard queries both slug shapes and feeds the result into `shouldRouteToJune`'s `hasInflightJob` term. Mirrors the sibling guards in [[../libraries/needs-attention-route-cs-owner]] and [[triage-escalations-cron]].
3. **Per-ticket compare-and-set.** Re-read the ticket at write time and re-check the full predicate (`shouldRouteToJune`) against actual message history so another sweep / a human reply / a human takeover between the batch read and the enqueue never produces a stale route. (Phase 3: the `active_playbook_id != null` hard exclusion here is removed too — playbook health is decided by the predicate's terms, not a blanket skip.)
4. **Idempotency marker.** Insert ONE internal `ticket_messages` note (direction `outbound`, visibility `internal`, author_type `system`). Non-playbook body: `[System] 30-min response SLA breached — routed to June`. Playbook body: `[System] 30-min response SLA breached while playbook <name> step <n> was active — routed to June; playbook state left intact`. Both forms contain the shared stem `SLA_BREACH_IDEMPOTENCY_STEM = "30-min response SLA breached"`, which the next sweep matches after the customer message to skip (`alreadyMarked`) — so the note form never breaks idempotency.
5. **Enqueue `cs-director-call`.** Same shape as [[triage-escalations-cron]] and [[../libraries/needs-attention-route-cs-owner]]: `spec_slug = ticket id`, `instructions = { ticket_id, sla_breach: { last_customer_at, last_response_at, waited_ms, sla_ms, source: 'ticket-response-sla-watchdog', playbook_id, playbook_step, playbook_name } }` (the three `playbook_*` fields are null when no playbook was active). **Never sets `escalated_to` to the founder** (or anyone — this surface leaves ticket escalation fields alone), and **never clears or mutates playbook state**; June's runner owns any status transition.
6. **Heartbeat.** `emitCronHeartbeat('ticket-response-sla-watchdog', { ok, produced, detail })` at the end of every run.

## Constants

- `TICKET_RESPONSE_SLA_MS = 30 min` — the breach threshold. Pinned in the unit test.
- `SLA_MAX_AGE_MS = 24 h` — don't resurrect an ancient open ticket; shares a ceiling with [[unanswered-inbound-backstop-cron]] `BACKSTOP_MAX_AGE_MS`.
- `SLA_BREACH_MARKER = "30-min response SLA breached — routed to June"` — the exact `[System]` note body for the non-playbook breach.
- `SLA_BREACH_IDEMPOTENCY_STEM = "30-min response SLA breached"` — the substring shared by BOTH the plain and the playbook-variant note. The next-sweep `alreadyMarked` check matches this stem, so either note form blocks a double-route; changing this string breaks idempotency.
- `BATCH = 25` — per-tick candidate cap.

## Pure predicate

`shouldRouteToJune(i: SlaBreachInput): boolean` — unit-pinned in `ticket-response-sla-watchdog.test.ts`. Returns true iff:

- a customer inbound external message exists and is aged into `[slaMs, maxAgeMs]`,
- no outbound customer-facing response sits at or after that message,
- no outbound send is queued (`pending_send_at && !sent_at && !send_cancelled`),
- no `ticket-handle`/`cs-director-call` job is in flight (`hasInflightJob`),
- no prior breach note (shared stem) sits after the customer message.

`activePlaybook: { id, step } | null` rides on the input too (Phase 3) — it does NOT gate the boolean (a non-playbook breach still routes), it just carries the playbook identity so the caller can name the playbook + step in June's brief and the internal note.

The predicate is the SAME shape as [[unanswered-inbound-backstop-cron]] `shouldBackstopRedispatch` — this cron catches the FAILED-TURN class while that cron catches the LOST-INGEST class; together they close the "nothing owns this ticket" gap for the full 30-min SLA.

## North-star contract

- **Never pages the founder from this surface.** The spec is explicit: breaches route to **June (`cs-director-call`)**, not the CEO. The founder owns objectives; June (the CS Director) owns tickets. See [[../operational-rules]] § North star.
- **Compare-and-set on every route.** The read-batch + per-ticket re-read + per-message idempotency marker together make a double-route impossible under racing sweeps or an async human reply.
- **Node-completeness trio** (CLAUDE.md hard rule): registered in `MONITORED_LOOPS` (owner `cs`, cadence 5 min, livenessWindowMs 20 min, satisfying `assertRegistryInvariants`'s 1.2× jitter grace); the `cs` department kill switch cascades down via the canonical registry so no separate `kill_switches` row is needed (fail-open invariant: MISSING ROW ⇒ ON); heartbeat emitted at the end of every run.

## Related

[[../specs/every-inbound-handled-within-30-min]] · [[unanswered-inbound-backstop-cron]] (sibling catch-net for the lost-ingest class) · [[triage-escalations-cron]] (hourly June-review enqueue — same `cs-director-call` shape) · [[../libraries/needs-attention-route-cs-owner]] (same enqueue + inflight-dedupe pattern) · [[../libraries/cs-director]] · [[../tables/agent_jobs]] · [[../tables/ticket_messages]] · [[../libraries/control-tower]]
