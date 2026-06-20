# libraries/improve-plan-executor

Runs an **approved** Improve action plan server-side ([[../specs/box-ticket-improve]] P2/P3). The box (Max `claude -p`) only *proposes* the plan ([[ticket-improve-chats]]); this executes it once the founder / CX manager approves, in the trusted Vercel runtime (service role + integration + GitHub creds — the same place today's Improve tab already runs [[improve-actions]]). Each plan-action kind maps to an existing executor; nothing here is freestyle DB writes.

**File:** `src/lib/improve-plan-executor.ts`

## Exports

### `executeImprovePlan` — function

```ts
async function executeImprovePlan(workspaceId, ticketId, actions: ImprovePlanAction[])
  : Promise<{ actions, results, resolved }>
```

Runs the `approved` actions (declined/other left untouched), returns the actions with updated `status`/`result`, a flat `results[]` log, and `resolved` (true if a `resolve_sequence` closed the ticket → the session flips to `resolved`).

## Execution order (deliberate)

1. **`customer_action` + `sonnet_prompt` + `grader_rule`** → mapped to [[improve-actions|ImproveAction]]s and run in ONE [[improve-actions|runImproveActions]] batch (preserves `{{label_url}}` chaining + its single internal results note). `sonnet_prompt`/`grader_rule` land `proposed` in [[../tables/sonnet_prompts]] / `grader_prompts` with `derived_from_ticket_id`.
   1b. **`orchestrator_action`** → builds an `ActionContext` from the ticket (`workspaceId`, `ticketId`, `customerId`, `channel` from `tickets.channel`, `sandbox` from `workspaces.sandbox_mode`) and calls **`executeSonnetDecision`** ([[action-executor]]) with the typed `decision` — the EXACT production path the orchestrator uses. Journeys/playbooks/workflows/macros/escalate + every direct action all run with production-correct delivery; the customer-facing `send` is the portal-aware [[ticket-delivery]] sink. Logs the decision + `reasoning` as an internal note first (North star: surface reasoning). Sets `resolved` if the decision closed the ticket. Mirrors `scripts/apply-coupon-via-executor.ts`. See [[../orchestrator-tools]] § Improve parity.
2. **`rescore`** → `analyzeTicket(ticketId, "manual")` ([[../lifecycles/ai-analysis]]) — forces a fresh `ticket_analyses` row.
3. **`ticket_spec`** → commits `docs/brain/specs/{slug}.md` to `main` via the GitHub Contents API, **owner = [[../functions/cs]]**, carrying a `Derived-from-ticket:` ref. **Never auto-builds** — surfaced on [[../dashboard/roadmap]] to commission (the `kind='build'` flow).
4. **`resolve_sequence`** LAST → post internal note(s) → close + unassign + unescalate ([[../tables/tickets]] `status='closed'`, `closed_at`, `escalated_at/to/reason=null`, `assigned_to=null`). Per-step flags (`close`/`unassign`/`unescalate`) default true; set false to skip.

## Gotchas

- **Server-side execution is the supervision boundary**, not the box. The box has no prod creds; this runtime does. Approval is the external human gate ([[../operational-rules]] § North star).
- **Idempotency / partials:** each action carries its own `status`/`result`; a failed action doesn't abort the batch. The route posts the combined results back into the transcript.
- `ticket_spec` slug is sanitized to `[a-z0-9-]`; re-committing the same slug updates the file (passes the current `sha`).
