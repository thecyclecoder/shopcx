# libraries/action-executor

**Status:** Mutation handlers migrated to [[../libraries/commerce__*]] (M4). All subscription/order/return/refund/loyalty actions route through unified Commerce SDK entry points.

Dispatches `SonnetDecision` JSON. Handles direct_action / journey / playbook / workflow / macro / kb_response / ai_response / escalate. Resolves handler_name against journeys, playbooks, workflows by name OR trigger_intent (case-insensitive). Single source of truth for executing AI decisions.

**File:** `src/lib/action-executor.ts`

## File header

```
Action Executor — executes actions from the Sonnet orchestrator's decision.
Takes a SonnetDecision (JSON action plan) and dispatches to the appropriate
handler: direct subscription actions, journeys, playbooks, workflows, macros,
KB/AI responses, or escalation.
```

## Exports

### `stripUnsubstitutedPlaceholders` — function

```ts
function stripUnsubstitutedPlaceholders(message: string) : string
```

### `executeSonnetDecision` — function

```ts
async function executeSonnetDecision(ctx: ActionContext, decision: SonnetDecision, personality: { name?: string; tone?: string; sign_off?: string | null } | null, send: SendFn, sysNote: SysNoteFn,) : Promise<
```

### `directActionHandlers` — const

```ts
const directActionHandlers: Record<
  string,
  (ctx: ActionContext, p: ActionParams)
```

### `SonnetDecision` — interface

### `ActionParams` — interface

### `ActionContext` — interface

### `ActionResult` — interface

## Callers

- `src/lib/inngest/ticket-research.ts`
- `src/lib/portal/handlers/account.ts`

## Gotchas

- **`bill_now` (and `change_next_date`'s ASAP/today fallback) route through [[../libraries/commerce__subscription]]'s unified entry points (M4 migration).** Internal (Braintree) subs fire `internal-subscription/renewal-attempt` ([[../inngest/internal-subscription-renewals]]); Appstle subs hit the commerce ops. Do NOT call legacy helpers directly — the unified entry points branch internally. (Historical escalation: ticket `dd67f3c7`, customer Angel — legacy direct call to `appstleAttemptBilling` was a NO-OP success on internal subs.)

- **Handlers that pass `p.contract_id` to Appstle must top-guard with `if (!p.contract_id) return { success: false, error: "Missing contract_id" }` — never trust the `!` non-null bang on an AI-populated field.** Under Sonnet, `contract_id` is optional on the decision JSON; a `!` compiles fine but URL-interpolates the literal string `undefined` into the Appstle endpoint, so the Java parser rejects it with `Failed to convert value of type String to required type Long ... For input string: undefined` (Vercel repair-signature `vercel:d1de82cb0b83d9ae`). `pause_timed` and `crisis_pause` guard at the handler boundary; keep the guard here — pushing it into `appstleSubscriptionAction` would mask the same bug in `reactivate`, `crisis_remove`, etc., that still use `p.contract_id!`. Fix each handler as its signature surfaces in Control Tower, not the shared helper.

- **`executeSonnetDecision` returns `{ messageSent, escalated, closed, statusManaged }`.** The `workflow` case returns `statusManaged: true` (via `handleWorkflow`, which returns `true` only when a workflow actually ran) because the workflow executor sets the authoritative final status itself in `sendReply` ([[workflow-executor]]: `account_login` → closed, `return_to_sender` → open). The post-execute block in [[../inngest/unified-ticket-handler]] (`postExecuteStatusAction`) must leave a status-managed ticket untouched — do NOT copy the journey case's `messageSent = true`, which routes through `setStatus` and always forces `closed`, wrongly closing an intentionally-open workflow. (Ticket `a89dcf76` Mindy Freeman: `account_login` magic-link close was being reopened as "no customer message sent".) See [[../lifecycles/ticket-lifecycle]] Phase 5.

---

[[../README]] · [[../../CLAUDE]]
