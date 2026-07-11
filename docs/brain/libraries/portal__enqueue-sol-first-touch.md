# libraries/portal/enqueue-sol-first-touch

Enqueue Sol's first-touch ticket-handle box session for a portal-error ticket. Phase 1 of [[../specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]]: a portal error now routes to Sol as the FIRST responder — she authors the durable `ticket_directions` row (intent = portal-error remediation) and ships the customer-facing fix — instead of the ticket falling through to the auto-healer's `escalate()` → [[../inngest/triage-escalations]] → `cs-director-call` June-review path. That June path stays available as Sol's Phase-3 rail hit; it is no longer the default portal-error route.

**File:** `src/lib/portal/enqueue-sol-first-touch.ts`

## What it does

`enqueueSolFirstTouchForPortalError(admin, {workspace_id, ticket_id, route, error_code})` inserts one `agent_jobs` row with:

| Column | Value |
|---|---|
| `workspace_id` | portal ticket's workspace |
| `kind` | `ticket-handle` |
| `spec_slug` | `ticket-handle-<first-8-of-ticket-id>` |
| `status` | `queued` |
| `instructions` | JSON: `{ticket_id, workspace_id, turn_index: 1, reason: "portal_error", route, error_code}` |

`turn_index=1` because no ack ticket_resolution_events row precedes Sol here — the portal customer already saw the error in the UI (unlike unified-ticket-handler's inbound-message first-touch, which sends an ack first).

## Design decisions

- **Dedupe guard before the mutating insert.** Same shape [[../inngest/triage-escalations]] uses: a `spec_slug` collision with any in-flight (`queued` | `queued_resume` | `claimed` | `building` | `needs_input`) ticket-handle job for this workspace skips the insert — no second Sol session fans out on a retry that reuses the portal route's open-ticket-from-the-last-hour dedupe. Confirming-predicate at the action point (Learning #2), not a coarser row-exists proxy.
- **Workspace-scoped dedupe.** The in-flight query filters by `workspace_id` so a cross-workspace `spec_slug` collision cannot mask a genuine enqueue. A ticket-handle job in workspace A never blocks the same-slug enqueue in workspace B.
- **Completed jobs don't block.** A previously `completed` / `failed` / `cancelled` ticket-handle job on the same ticket does NOT block a fresh enqueue — a repeat portal error weeks later needs a fresh Sol session.
- **No `ticket_id` column on `agent_jobs`.** Same shape ticket-improve / triage-escalations use: the per-kind payload rides in `instructions` (JSON) so the queue view stays uniform. `runTicketHandleJob` (`scripts/builder-worker.ts`) parses `ticket_id` + `workspace_id` from that blob.

## Exports

- `enqueueSolFirstTouchForPortalError(admin, input)` → `EnqueueOutcome` — inserts the agent_jobs row.
- `enqueueSolFirstTouchForCoraRemediation(admin, {workspace_id, ticket_id, score?, analysis_id?})` → `EnqueueOutcome` — the **tiered-remediation-ladder** sibling (cora-tiered-remediation-ladder-cheap-fail-resessions-sol-not-june). Same `agent_jobs` insert + same `ticket-handle-<first-8>` dedupe, but `instructions.reason='cora_remediation'` (not `portal_error`) so `runTicketHandleJob` runs it as an ordinary first-touch — Sol re-handles from scratch a ticket the cheap Sonnet/Haiku path mishandled and she never touched. Called by [[./ticket-analyzer]] `applySeverityActions` when `decideRemediationTier` returns `resession_sol`. The `cheap_tier_score` + `analysis_id` ride in the instructions for the box-session context + the ledger link.
- `specSlugForTicketHandle(ticket_id)` → `string` — the deterministic slug the enqueue + dedupe key uses (shared by both enqueue paths so a ticket never fans out two concurrent Sol sessions across the portal + Cora routes).

## Callers

- `src/app/api/portal/route.ts` — after creating (or reusing) a `portal-action-failed` ticket, the intake calls `enqueueSolFirstTouchForPortalError` so Sol's box session opens on the fresh ticket. The customer-facing HTTP response is not wedged on an enqueue miss (best-effort — the auto-heal cron still surfaces the ticket).
- [[./ticket-analyzer]] `applySeverityActions` — calls `enqueueSolFirstTouchForCoraRemediation` on the ladder's cheap-tier-mishandle rung (re-session Sol instead of escalating June). Best-effort — an enqueue failure never wedges the grade.

## Related

- [[./portal__remediation]] — the auto-heal / dismiss / escalate lane that runs on the 15-min [[../inngest/portal-action-healer]] cron. Unchanged in Phase 1; Phase 3 will remap its `escalate()` to Sol's rail-hit path.
- [[./ticket-directions]] — the SDK Sol calls to write the durable Direction on the box session's return.
- [[../inngest/triage-escalations]] — the June-review cron. In Phase 1 portal errors bypass this on the happy path; in Phase 3 it becomes Sol's rail hit.
- [[../inngest/unified-ticket-handler]] — the sibling first-touch dispatch for inbound customer messages.

---

[[../README]] · [[../../CLAUDE]] · [[../specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]]
