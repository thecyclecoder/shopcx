# libraries/roadmap-chats

Server helpers for the persisted Roadmap authoring chat ([[../tables/roadmap_chats]]). Save/load a conversation transcript so the chat survives closing the modal and resumes cross-device. All writes go through `createAdminClient()` (service role).

**File:** `src/lib/roadmap-chats.ts`

## Types

`ChatMsg` (`{ role: "user"｜"assistant"; content: string }`) · `ChatStatus` (`"active"｜"finalized"`) · `TurnStatus` (`"idle"｜"thinking"｜"error"` — box-spec-chat per-turn lifecycle) · `RoadmapChat` (a full row, now incl. `box_session_id`/`turn_status`/`last_error`) · `SaveChatInput`.

## Exports

### `saveChat` — function

```ts
async function saveChat(input: SaveChatInput) : Promise<RoadmapChat | null>
```

Upsert: no `id` → insert a new row; with `id` → update (transcript autosave, `status`/`spec_slug` on finalize). `messages` are validated/normalized; `updated_at` bumped every save. Update is workspace-scoped.

### `loadChat` — function

```ts
async function loadChat(workspaceId: string, id: string) : Promise<RoadmapChat | null>
```

### `loadActiveChatForSlug` — function

```ts
async function loadActiveChatForSlug(workspaceId: string, specSlug: string) : Promise<RoadmapChat | null>
```

Latest still-`active` session for a spec slug (refine resume).

### `listRecentChats` — function

```ts
async function listRecentChats(workspaceId: string, userId: string, limit = 20) : Promise<RoadmapChat[]>
```

Recent `active` sessions for the user's workspace (resume list), newest first.

### `markTurnThinking` — function

```ts
async function markTurnThinking(workspaceId: string, id: string, userMessage?: string) : Promise<RoadmapChat | null>
```

**box-spec-chat** — append an optional user turn to `messages`, set `turn_status='thinking'`, clear `last_error`; returns the updated row. The chat route calls this before enqueuing the `spec-chat` box job; the box (`runSpecChatJob`) later appends the assistant reply + flips `turn_status` back to `idle` (or `error`).

## Callers

- `src/app/api/roadmap/chat-session/route.ts` (owner-gated POST/GET).
- `src/app/api/roadmap/chat/route.ts` (owner-gated; `markTurnThinking` + `saveChat`/`loadChat` to drive a box spec-chat turn).
- `scripts/builder-worker.ts` → `runSpecChatJob` reads/writes the row directly via the service-role admin client (not these helpers). A board-triggered turn (`instructions` carry a `BoardReplyLink`) also posts the answer back onto the #directors board (`postBoardAnswer`).
- `src/lib/agents/director-board.ts` → `routeBoardReply` calls `saveChat`/`markTurnThinking` when a board "why?" is about a specific spec (`metadata.spec_slug`) — routes spec context to spec-chat ([[director-board]], directors-board-gamified Phase 2).

## Related

[[../tables/roadmap_chats]] · [[../lifecycles/roadmap-build-console]] · [[../dashboard/roadmap]] · [[../specs/box-spec-chat]] · [[director-board]]
