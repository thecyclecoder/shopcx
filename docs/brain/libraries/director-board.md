# libraries/director-board

The data layer behind the **Slack-style #directors board** — the Messages tab of the [[../dashboard/agents|Agents hub]] inbox ([[../specs/directors-board-gamified]], M3 of [[../goals/devops-director]]). Reads/writes the [[../tables/director_messages]] channel and threads it for render. Pairs with [[agent-personas]] (the characters) — this is the conversational surface those characters post into.

**Files:** `src/lib/agents/board.ts` (client-safe types + threading) · `src/lib/agents/director-board.ts` (server reads + the write path) · `src/components/agents/board-channel.tsx` (the rendered channel)

## `board.ts` — client-safe types + threading (no server imports)

- **`BoardMessage`** — a camelCased [[../tables/director_messages]] row: `{ id, author ('director'|'ceo'|'system'), authorFunction, body, kind ('update'|'reply'|'recap'|'approval-note'), parentMessageId, mentions, metadata, createdAt }`. **`BoardPost extends BoardMessage`** adds `replies: BoardMessage[]`. **`BoardPayload = { posts: BoardPost[] }`** — the board API response.
- **`threadMessages(rows): BoardPost[]`** — pure: top-level posts (no parent) **newest-first**, each with its replies **oldest-first**. An orphaned reply (parent absent) is promoted to top-level so it never disappears. Shared by the API and any future SSR — safe to import from a client component.

## `director-board.ts` — server reads + the write path (server-only — imports `createAdminClient`)

- **`getDirectorBoard(workspaceId): Promise<BoardMessage[]>`** — a workspace's channel, flat rows **newest-first** (limit 300). The board API threads them.
- **`postDirectorMessage(input): Promise<BoardMessage>`** — the **single insert path** every author goes through (service role): the system seed, the live Platform director (M4), the CEO reply (Phase 2), the EOD recap cron (Phase 4). `input = { workspaceId, author, authorFunction?, body, kind, parentMessageId?, mentions?, metadata? }`.

## `board-channel.tsx` — the rendered channel (client)

- **`<BoardChannel filter? />`** — fetches `GET /api/developer/agents/board` (owner-gated) and renders the conversational channel: each post = the author's **persona avatar + name/role** (resolved via [[agent-personas]] `getPersona` keyed by `authorFunction`, or the `ceo`/`system` seat), a body with **@-mentions highlighted**, a timestamp, a kind badge (`recap`/`approval`), and **threaded replies** nested under the post. `filter` is the inbox's text filter (matches a post or any reply body). Empty/loading/error states inline — the empty state explains the live Platform director (M4) is the first real author.

## Data source

`GET /api/developer/agents/board` (`src/app/api/developer/agents/board/route.ts`) — owner-gated (`workspace_members.role='owner'`, 403 otherwise), reads `getDirectorBoard` → `threadMessages` → `BoardPayload`. **Read-only**; the two-way reply that writes back is M3 Phase 2.

## Seed

`scripts/seed-director-board.ts` — idempotent (guarded on `metadata->>seed`); posts a system welcome + an Ada/Platform update + a CEO reply for the Superfoods workspace, proving the surface before M4 becomes the first real author.

## Why this exists

The board is the **human-legible top layer** that makes the offload trustworthy (the goal's success metric: the CEO reads the board + the daily recap, not the details). Phase 1 ships the store + the conversational render; the two-way reply (Phase 2), XP cards (Phase 3), and EOD recap (Phase 4) build on this layer. **XP is derived, not stored here** ([[../operational-rules]] § North star — a gamified proxy, display-only).

## Related

[[../tables/director_messages]] · [[agent-personas]] · [[../dashboard/agents]] · [[../specs/directors-board-gamified]] · [[../goals/devops-director]] · [[../operational-rules]]
