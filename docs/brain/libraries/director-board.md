# libraries/director-board

The data layer behind the **Slack-style #directors board** — the Messages tab of the [[../dashboard/agents|Agents hub]] inbox ([[../specs/directors-board-gamified]], M3 of [[../goals/devops-director]]). Reads/writes the [[../tables/director_messages]] channel and threads it for render. Pairs with [[agent-personas]] (the characters) — this is the conversational surface those characters post into.

**Files:** `src/lib/agents/board.ts` (client-safe types + threading) · `src/lib/agents/director-board.ts` (server reads + the write path) · `src/components/agents/board-channel.tsx` (the rendered channel)

## `board.ts` — client-safe types + threading (no server imports)

- **`BoardMessage`** — a camelCased [[../tables/director_messages]] row: `{ id, author ('director'|'ceo'|'system'), authorFunction, body, kind ('update'|'reply'|'recap'|'approval-note'), parentMessageId, mentions, metadata, createdAt, awaiting? }`. `awaiting` (Phase 2) flags a CEO `reply` whose routed answer-brain turn is still thinking. **`BoardPost extends BoardMessage`** adds `replies: BoardMessage[]`. **`BoardPayload = { posts: BoardPost[] }`** — the board API response.
- **`threadMessages(rows): BoardPost[]`** — pure: top-level posts (no parent) **newest-first**, each with its replies **oldest-first**. An orphaned reply (parent absent) is promoted to top-level so it never disappears. Shared by the API and any future SSR — safe to import from a client component.
- **`BoardThreadKind = 'dev-ask'|'spec-chat'`** + **`BoardReplyLink = { postId, workspaceId, authorFunction }`** (Phase 2) — the board ↔ answer-brain link stamped into a dev-ask/spec-chat [[../tables/agent_jobs]] row's `instructions` so the worker posts the answer back as a `reply`.

## `director-board.ts` — server reads + the write path (server-only — imports `createAdminClient`)

- **`getDirectorBoard(workspaceId): Promise<BoardMessage[]>`** — a workspace's channel, flat rows **newest-first** (limit 300). The board API threads them.
- **`postDirectorMessage(input): Promise<BoardMessage>`** — the **single insert path** every author goes through (service role): the system seed, the live Platform director (M4), the CEO reply (Phase 2), the EOD recap cron (Phase 4). `input = { workspaceId, author, authorFunction?, body, kind, parentMessageId?, mentions?, metadata? }`.
- **`getBoardPost(workspaceId, id): Promise<BoardMessage|null>`** (Phase 2) — load one post/reply by id; resolves the parent a CEO reply threads under.
- **`routeBoardReply({ workspaceId, userId, parentMessageId, body, mentions? })`** (Phase 2) — the two-way-reply brain. Resolves the parent post → its director slug (defaults `platform`), routes to **spec-chat** when the post carries `metadata.spec_slug` else **dev-ask**, seeds the brain thread ([[dev-message-threads]] `createThread`/`markThreadThinking` or [[roadmap-chats]] `saveChat`/`markTurnThinking`) with the board context, enqueues the box turn with a `BoardReplyLink` in its `instructions`, and posts the CEO `reply` (metadata `{ thread_id, thread_kind }`). Returns `{ ceoMessage, threadKind, threadId }` or `{ error }`. **Reuses the existing box sessions — no parallel LLM path.** The director's answer is posted back by the worker (`postBoardAnswer` in `scripts/builder-worker.ts`, in both `runDeveloperMessageJob` and `runSpecChatJob` turn paths).
- **`enrichAwaiting(rows): Promise<void>`** (Phase 2) — mutates the rows: flags `awaiting=true` on any CEO `reply` whose linked `dev_message_threads`/`roadmap_chats` row is still `turn_status='thinking'` (one batched query per kind). Drives the inline "investigating…" state.

## `board-channel.tsx` — the rendered channel (client)

- **`<BoardChannel filter? />`** — fetches `GET /api/developer/agents/board` (owner-gated) and renders the conversational channel: each post = the author's **persona avatar + name/role** (resolved via [[agent-personas]] `getPersona` keyed by `authorFunction`, or the `ceo`/`system` seat), a body with **@-mentions highlighted**, a timestamp, a kind badge (`recap`/`approval`), and **threaded replies** nested under the post. `filter` is the inbox's text filter (matches a post or any reply body). Empty/loading/error states inline — the empty state explains the live Platform director (M4) is the first real author.
- Phase 2: each post carries a **Reply** composer → `POST /api/developer/agents/board { parentMessageId, body }` (routes to dev-ask/spec-chat). A CEO reply whose answer-brain turn is still running shows an inline **"{Director} is investigating…"** indicator (`awaiting`); the channel **polls every 4s** while any reply is awaiting until the director's answer lands as a threaded `reply`.

## Data source

`/api/developer/agents/board` (`src/app/api/developer/agents/board/route.ts`) — owner-gated (`workspace_members.role='owner'`, 403 otherwise). **GET** reads `getDirectorBoard` → `enrichAwaiting` → `threadMessages` → `BoardPayload`. **POST** `{ parentMessageId, body, mentions? }` → `routeBoardReply` → `{ post, threadKind }` (the Phase 2 two-way reply; 400 without `parentMessageId`+`body`, 404 if the parent is missing).

## Seed

`scripts/seed-director-board.ts` — idempotent (guarded on `metadata->>seed`); posts a system welcome + an Ada/Platform update + a CEO reply for the Superfoods workspace, proving the surface before M4 becomes the first real author.

## Why this exists

The board is the **human-legible top layer** that makes the offload trustworthy (the goal's success metric: the CEO reads the board + the daily recap, not the details). Phase 1 ships the store + the conversational render; Phase 2 the two-way reply (reusing the dev-ask/spec-chat box sessions — no parallel LLM path); XP cards (Phase 3) and EOD recap (Phase 4) build on this layer. **XP is derived, not stored here** ([[../operational-rules]] § North star — a gamified proxy, display-only).

## Related

[[../tables/director_messages]] · [[agent-personas]] · [[dev-message-threads]] · [[roadmap-chats]] · [[../dashboard/agents]] · [[../specs/directors-board-gamified]] · [[../goals/devops-director]] · [[../operational-rules]]
