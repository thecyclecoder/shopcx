# libraries/workflow-executor

Template-based deterministic workflow executor: order_tracking, account_login, end_chat. Distinct from [[playbook-executor]].

**File:** `src/lib/workflow-executor.ts`

## Exports

### `executeWorkflow` — function

```ts
async function executeWorkflow(workspaceId: string, ticketId: string, triggerTag: string, options?: ExecuteWorkflowOptions,) : Promise<void>
```

### `buildContext` — function

```ts
async function buildContext(admin: Admin, workspaceId: string, ticketId: string) : Promise<WorkflowContext>
```

### `resolveTemplate` — function

```ts
function resolveTemplate(template: string, context: WorkflowContext) : string
```

### `WorkflowContext` — interface

### `ExecuteWorkflowOptions` — interface

## Callers

- `src/app/api/tickets/[id]/run-workflow/route.ts`

## Gotchas

- **`sendReply` sets the authoritative final ticket status per step** (`statusOverride` arg, default `"closed"`; `closed` also stamps `resolved_at` + `closed_at`). Examples: `account_login` magic-link → `closed`, `return_to_sender` → `open`, several escalating replies → `open`. Because the workflow owns the status, [[action-executor]]'s `workflow` action returns `statusManaged: true` and the orchestrator's post-execute block ([[../inngest/unified-ticket-handler]] `postExecuteStatusAction`) must NOT override it. (Ticket `a89dcf76` Mindy Freeman: an `account_login` close was being reopened.) See [[../lifecycles/ticket-lifecycle]] Phase 5.

---

[[../README]] · [[../../CLAUDE]]
