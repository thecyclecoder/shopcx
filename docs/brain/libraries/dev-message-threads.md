# libraries/dev-message-threads

Server helpers for the **Developer Message Center** thread store ([[../tables/dev_message_threads]]). Create/load a read-only "ask the box anything" conversation, mark a turn thinking, and record the owner's decision on an approval card. All writes go through `createAdminClient()` (service role). See [[../specs/developer-message-center]].

**File:** `src/lib/dev-message-threads.ts`

## Types

`ThreadMsg` (`{ role: "user"｜"assistant"; content: string }`) · `TurnStatus` (`"idle"｜"thinking"｜"error"`) · `DevThreadActionType` (`"db_mutation"｜"spec"`) · `DevThreadActionStatus` (`"pending"｜"approved"｜"declined"｜"done"｜"failed"`) · `DevThreadAction` (one approval card) · `DevMessageThread` (a full row, incl. `messages`/`box_session_id`/`turn_status`/`last_error`/`pending_actions`).

> Note: the **worker** parks cards using the [[../tables/agent_jobs]] `PendingAction` shape (`type:'run_prod_script'` for a db_mutation, `type:'spec'` for a handoff); this lib's `DevThreadActionType` is the normalized client/route view.

## Exports

### `createThread` — function

```ts
async function createThread(input: { workspaceId: string; userId: string; title?: string | null; message: string }) : Promise<DevMessageThread | null>
```

Insert a new thread with the opening user message (title defaults to the message, truncated). `updated_at` set.

### `loadThread` — function

```ts
async function loadThread(workspaceId: string, id: string) : Promise<DevMessageThread | null>
```

### `markThreadThinking` — function

```ts
async function markThreadThinking(workspaceId: string, id: string, userMessage?: string) : Promise<DevMessageThread | null>
```

Append an optional user turn to `messages`, set `turn_status='thinking'`, clear `last_error`; returns the updated row. The route calls this before enqueuing the `dev-ask` box job; the box (`runDeveloperMessageJob`) later appends the assistant reply + flips `turn_status` back to `idle` (or `error`).

### `setActionDecision` — function

```ts
async function setActionDecision(workspaceId: string, id: string, actionId: string, decision: "approve" | "decline") : Promise<DevMessageThread | null>
```

Flip one **pending** card to `approved`/`declined`. On approve it also sets `turn_status='thinking'` (a `dev-ask` `{mode:'approve_action'}` job will execute it); decline is terminal (no box turn).

### `listRecentThreads` — function

```ts
async function listRecentThreads(workspaceId: string, userId: string, limit = 20) : Promise<DevMessageThread[]>
```

Recent threads for the user's workspace (resume list), newest first.

## Callers

- `src/app/api/developer/messages/route.ts` (owner-gated POST chat/retry/approve + GET load/list).
- `scripts/builder-worker.ts` → `runDeveloperMessageJob` reads/writes the row directly via the service-role admin client (not these helpers), incl. executing approved cards. When the turn was triggered from the **#directors board** (the job's `instructions` carry a `BoardReplyLink`), it also posts the answer back onto the board (`postBoardAnswer`).
- `src/lib/agents/director-board.ts` → `routeBoardReply` calls `createThread`/`markThreadThinking` to spin up a board-triggered "why?" investigation ([[director-board]], directors-board-gamified Phase 2).

## Related

[[../tables/dev_message_threads]] · [[../specs/developer-message-center]] · [[../recipes/dev-message-center-db]] · [[../tables/agent_jobs]] · [[roadmap-chats]] · [[director-board]]
