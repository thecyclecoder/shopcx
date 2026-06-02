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

_None documented._

---

[[../README]] · [[../../CLAUDE]]
