# libraries/ticket-improve-chats

Server helpers + shared types for the box-hosted ticket Improve agent ([[../tables/ticket_improve_chats]] · [[../specs/box-ticket-improve]]). Load/create/patch the ticket-bound session and define the typed action-plan shapes the box proposes and the route executes. All writes go through `createAdminClient()` (service role).

**File:** `src/lib/ticket-improve-chats.ts`

## Types

- `ChatMsg` (`{ role: "user"｜"assistant"; content }`) · `TurnStatus` (`idle｜thinking｜error｜awaiting_approval`) · `SessionStatus` (`active｜resolved`).
- `ImprovePlanActionKind` = `customer_action｜sonnet_prompt｜grader_rule｜rescore｜ticket_spec｜resolve_sequence`.
- `ImprovePlanAction` — one proposed action: `{ id, kind, label, detail?, status }` + exactly one payload by kind: `action` (an [[improve-actions|ImproveAction]] direct-action), `prompt` (`{title,content,category?}`), `rule` (`{title,content}`), `spec` (`{slug,title,intent,problem}`), or `resolve` (`{internal_notes?, close?, unassign?, unescalate?}`).
- `ImprovePlan` (`{ summary, actions[] }`) · `TicketImproveChat` (a full row).

## Exports

### `loadOrCreateSession` — function

```ts
async function loadOrCreateSession(workspaceId, ticketId, userId): Promise<TicketImproveChat | null>
```

Returns the ticket's session, inserting a fresh one if none exists (one per ticket — the UNIQUE `ticket_id` index). Used by `POST {action:'send'}`.

### `loadSession` — function

```ts
async function loadSession(workspaceId, ticketId): Promise<TicketImproveChat | null>
```

Read-only load (no create) — the `GET`/poll target and the `execute` pre-read.

### `patchSession` — function

```ts
async function patchSession(workspaceId, id, patch): Promise<TicketImproveChat | null>
```

Workspace-scoped update by id; bumps `updated_at`; returns the fresh row.

## Callers

- `src/app/api/tickets/[id]/improve/route.ts` — the Improve route (send / execute / GET).
- [[improve-plan-executor]] consumes `ImprovePlanAction[]` to run the approved plan.
- `scripts/builder-worker.ts` writes the row directly (service-role) — it duplicates the jsonb shape rather than importing this module (the worker uses relative imports).

## Gotchas

- The `ImproveAction` import is **type-only** (`import type`) so this module's plan types are safe to reference from the client component without pulling server code into the bundle.
- The box never executes — these helpers only persist the conversation + the *proposed* plan; mutation is [[improve-plan-executor]] server-side after approval.
