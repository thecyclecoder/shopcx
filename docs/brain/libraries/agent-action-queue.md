# agent-action-queue

`src/lib/agent-action-queue.ts` — the **enqueue → worker-execute → poll** spine for Sol's cheap-execution. Sol's read-only box session's only write is a bounded, schema-validated request row in [[../tables/agent_action_requests]]; the deterministic execute-worker (a 1.5s drain in [[../../scripts/builder-worker]], write creds) runs it through the ONE executor and writes the verified result back. See [[../tables/agent_action_requests]] for the model + why it supersedes the [[ticket-required-outcomes]] honor step.

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `AgentActionStatus` | type | `pending\|pending_condition\|running\|done\|failed\|expired` |
| `TriggerCondition` | interface | `{type, …}` — condition a `pending_condition` row waits on (deferred actions) |
| `AgentActionRequest` | interface | the row shape |
| `validateDecision(decision)` | `Promise<{ok, error?}>` | THE anti-hallucination boundary — checks `action_type` + (for `direct_action`) that every `actions[].type` is a real key in `directActionHandlers` (imported at runtime → zero drift with the executor). Runs in the trusted CLI/worker, never the LLM. |
| `enqueueActionRequest(admin, args)` | insert | validate + insert; `triggerCondition` → `pending_condition`, else `pending` |
| `claimNextPending(admin)` | CAS claim | atomically move the oldest `pending` row → `running` (lost-race safe) |
| `executeActionRequest(admin, req)` | run | blanks `response_message` for a `direct_action` (action-only, no double-send), runs `runTicketDecision` (dry_run → `sandbox=true`), records outcome-ledger rows (skipped on dry_run), writes `result` (incl. `ok = !escalated`). Catches → `failRequest`; NO false success reaches the customer. |
| `getRequest(admin, id)` | read | single row (Sol's poll) |
| `waitForTerminal(admin, id, {timeoutMs?, intervalMs?})` | long-poll | block until `done`/`failed`/`expired` or timeout (default 20s/750ms) |
| `drainPendingOnce(admin, max=10)` | worker tick | claim + execute up to `max`; the execute-worker's per-interval body |

## Tolerant verify (the fix)

Success = the executor's OWN handler result (`!escalated` from `runTicketDecision`) — the real Appstle/DB call — NOT the honor step's brittle `expected_db_state` exact-match that false-failed Sofia's Oct-1-vs-Oct-2 renewal. `result.ok=false` tells Sol it didn't land so she ADAPTS (retry / journey / needs_human / honest reply) instead of promising it.

## Callers

- Box tool [[../../scripts/agent-action-tools]] (`enqueue` / `poll`) — Sol's write-side CLI.
- Execute-worker drain in [[../../scripts/builder-worker]] `main()` (setInterval → `drainPendingOnce`).

Related: [[tickets-mutate]] (`runTicketDecision`, the executor front door) · [[ticket-required-outcomes]] (the outcome ledger the claim-guard reads) · [[sol-outcome-claim-guard]].
