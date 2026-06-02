# libraries/playbook-executor

Step engine for [[../playbooks]]. Routes inbound messages through playbook steps when `active_playbook_id` is set on the ticket.

**File:** `src/lib/playbook-executor.ts`

## File header

```
Playbook Executor — runs playbook steps against live customer data.
Called from the unified ticket handler when a playbook is active or matched.
Each step fetches live data, evaluates conditions, generates AI response,
and advances (or waits for customer reply).
```

## Exports

### `executePlaybookStep` — function

```ts
async function executePlaybookStep(workspaceId: string, ticketId: string, customerMessage: string, personality: { name?: string; tone?: string; sign_off?: string | null } | null,) : Promise<PlaybookExecResult>
```

### `matchPlaybook` — function

```ts
async function matchPlaybook(admin: Admin, wsId: string, intent: string, msg: string,) : Promise<
```

### `startPlaybook` — function

```ts
async function startPlaybook(admin: Admin, ticketId: string, playbookId: string,) : Promise<void>
```

### `PlaybookExecResult` — interface

## Callers

- `src/lib/inngest/unified-ticket-handler.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
