# inngest/founder-escalation-stale-recheck

The hourly sweep that keeps a **founder-escalated ticket from rotting in silence**. Phase 2 of [[../specs/a-founder-escalated-customer-never-waits-in-silence]]. When a ticket has been escalated to the CEO for **≥48h** with no resolution AND the **customer has written again since the escalation**, this cron re-enqueues one `cs-director-call` (June-review) so [[../libraries/cs-director|June]] re-reads with fresh state — capped at **two re-checks per ticket** so a genuinely founder-only decision does not become a loop that pages June forever.

**File:** `src/lib/inngest/founder-escalation-stale-recheck.ts` (registered in `src/lib/inngest/registered-functions.ts` → served by `src/app/api/inngest/route.ts`)

## Functions

### `founder-escalation-stale-recheck-cron`
- **Trigger:** cron `45 * * * *` (hourly on the 45 — offset from [[triage-escalations]]'s :30 so the two crons don't stampede the shared `cs-director-call` lane in the same minute)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## Why it exists

The founder lane is the OUTLIER on wait-times across every escalation lane. Measured across 16 multi-message streaks since 2026-07-01 the median wait was **1.0h** across ALL lanes; three of the four multi-day stalls in that window were founder-escalated: **232h** (jleone@earthlink.net), **75h** (bellamyjs@msn.com), **46h** (jhb222@aol.com). Susan Bellamy sent four more messages into that silence and abandoned a subscription she was actively trying to buy. The routing decision was RIGHT every time — what the customer experienced was not.

Phase 1 shipped the honest one-line Suzie acknowledgement so the silence stops reading as being ignored. Phase 2 is the un-stall: the customer still hears from us on stale founder escalations, AND June — now materially better equipped than she was when these first escalated (the policy package shipped 2026-08-02, a derived grandfathered-price restore is moving into her leash) — gets a re-read window on tickets she can now handle herself.

## What it enqueues

For each **founder-owned escalated ticket** — `escalated_at IS NOT NULL AND escalated_to IS NOT NULL AND status NOT IN ('archived','closed') AND now() - escalated_at ≥ FOUNDER_STALE_RECHECK_HOURS` (default 48h) — that ALSO has at least one inbound customer message since `escalated_at`, and is under the recheck cap, the cron inserts one `queued` `agent_jobs` row `kind='cs-director-call'` with:

```jsonc
{
  "spec_slug": "<ticket_uuid>",
  "kind": "cs-director-call",
  "status": "queued",
  "instructions": {
    "ticket_id": "<ticket_uuid>",
    "recheck": true,
    "recheck_index": <1 | 2>
  }
}
```

The `recheck_index` is `1` on the first stale re-check and `2` on the second (the cap). The box's [`cs-director-call` skill](../libraries/cs-director.md) runs June's read-only re-review; the executor `applyBoxCsDirectorCall` (`src/lib/cs-director.ts`) routes her verdict — an `approve_remedy` fires the in-leash fix and delivers the customer message, an `escalate_founder` (again) minted the ack in Suzie's voice using [[../libraries/cs-director|composeFounderEscalationAck]]'s recheck-aware variant so the customer never hears the same greeting twice. Per-tick cap: `FOUNDER_STALE_RECHECK_ENQUEUE_CAP_PER_TICK` (default 20).

## Ownership

The recheck's outcome is **June's, not the founder's** — the whole point is to unstall the ticket without adding another CEO ping when the answer is now in-leash. Three shapes are possible on recheck (the same three the primary triage produces):

- **`approve_remedy`** — June can now handle in leash. Her handler fires the fix + delivers the reply. The prior CEO card is left in place for now; a follow-up spec can wire the withdrawal (Phase 2's verification is the re-check itself).
- **`escalate_founder` (again)** — still a genuine founder call. `handleEscalateFounder` composes a SECOND, DIFFERENT acknowledgement — the recheck-aware variant of [[../libraries/cs-director|composeFounderEscalationAck]] — and delivers it. Cap invariant means at most three acks total (initial + 2 rechecks) will ever land on one ticket, all different.
- **`author_spec` / `close_no_action`** — same terminal semantics as the primary triage.

## Dedupe / gates (per-ticket, applied in order)

1. **Ticket-level eligibility** — pure predicate `passesFounderStaleRecheckSelection` (pinned in `src/lib/inngest/founder-escalation-stale-recheck.selection.test.ts`). Founder-owned, open, ≥48h old.
2. **Customer-wrote-again gate** — at least one inbound message with `direction='inbound' AND author_type='customer'` whose `created_at > tickets.escalated_at`. Silence alone is a one-way completed message; the pattern this cron targets is silence WHILE THE CUSTOMER KEEPS ASKING.
3. **Inflight guard** — skip a ticket that already has a `cs-director-call` job in an active status (`queued|queued_resume|claimed|building|needs_input`). No dup enqueue per hourly tick.
4. **Recheck cap** — pure counter `countPriorFounderRechecks` counts prior `cs-director-call` jobs on this ticket whose `instructions.recheck === true`. When the count is ≥ `FOUNDER_RECHECK_CAP` (default 2), the sweep stops enqueuing for that ticket forever. Ledger-derived (not a column on `tickets`) so a manual re-run works too.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box (it only reaches out — [[../recipes/build-box-setup]]).

## Tables written

- **`agent_jobs`** — inserts one row per eligible ticket with `kind='cs-director-call'`, `status='queued'`.
- **`loop_heartbeats`** — end-of-run heartbeat via [[../libraries/control-tower|emitCronHeartbeat]] with `loop_id='founder-escalation-stale-recheck-cron'`, matching the [[../libraries/control-tower|MONITORED_LOOPS]] registry entry (owner: `cs`).

## Tunables (env)

- `FOUNDER_STALE_RECHECK_HOURS` — staleness cutoff, default **48h**. Widen to catch the 46h class (jhb222@aol.com's shape); tighten to reduce June's load. The three worst historical stalls (232h, 75h) both clear this threshold by a wide margin.
- `FOUNDER_RECHECK_CAP` — max rechecks per ticket, default **2**. Do NOT widen without the CEO — the cap exists so a genuinely founder-only decision does not become a June-page loop.
- `FOUNDER_STALE_RECHECK_ENQUEUE_CAP_PER_TICK` — per-tick enqueue cap, default **20**. Prevents a large stale backlog from blowing the shared `cs-director-call` lane in one hourly tick.

## Related

- [[../specs/a-founder-escalated-customer-never-waits-in-silence]] — the parent spec.
- [[triage-escalations]] — the primary escalation triage cron (routine-owned tickets). This cron's founder-owned cousin.
- [[../libraries/cs-director]] — `handleEscalateFounder`, `composeFounderEscalationAck` (recheck-aware).
- [[../tables/agent_jobs]] — the queue this cron enqueues into.
- [[../tables/tickets]] — the source rows.
