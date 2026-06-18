# libraries/roadmap-chats

Server helpers for the persisted Roadmap authoring chat ([[../tables/roadmap_chats]]). Save/load a conversation transcript so the chat survives closing the modal and resumes cross-device. All writes go through `createAdminClient()` (service role).

**File:** `src/lib/roadmap-chats.ts`

## Types

`ChatMsg` (`{ role: "user"｜"assistant"; content: string }`) · `ChatStatus` (`"active"｜"finalized"`) · `RoadmapChat` (a full row) · `SaveChatInput`.

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

## Callers

- `src/app/api/roadmap/chat-session/route.ts` (owner-gated POST/GET).

## Related

[[../tables/roadmap_chats]] · [[../specs/authoring-chat-persistence]] · [[../lifecycles/roadmap-build-console]] · [[../dashboard/roadmap]]
