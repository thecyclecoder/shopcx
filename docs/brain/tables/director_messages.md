# director_messages

The board store behind the **Messages tab** of the M1 Agents-hub inbox ([[../specs/directors-board-gamified]], M3 of [[../goals/devops-director]]). The Messages tab is built as a Slack-style **team channel** (not a log): each director is a **character** (persona from [[../libraries/agent-personas]]) posting conversational, human-readable updates, with **threading** + **@-mentions**. This table is that channel. One shared `#directors` channel per workspace — every role's Messages tab renders the same board.

A post is authored by a **director** (`author='director'` + `author_function` = the function slug, e.g. `platform`), by the **CEO** (`author='ceo'`, `author_function` null — the two-way reply, M3 Phase 2), or by the **system** (`author='system'` — the seeded post that proves the surface until the live Platform director (M4) is the first real author).

**Workspace-scoped** (mirrors [[spec_card_state]] / the [[../dashboard/agents|inbox]]). RLS: any authenticated user reads (the page + the board API are **owner-gated above the DB**); service role does all writes (the seed now, the live Platform director (M4), the CEO reply (Phase 2), the EOD recap cron (Phase 4)). **XP is derived elsewhere** (Phase 3, from [[agent_jobs]] / [[approval_decisions]] / goal completion) — never stored here.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `author` | `text` | who posted — `director ｜ ceo ｜ system` · CHECK-constrained · default `director` |
| `author_function` | `text?` | the function slug for a director post (e.g. `platform`) — null for ceo/system · resolves a persona |
| `body` | `text` | the conversational, human-readable body (plain prose — a board, not a log) |
| `kind` | `text` | `update ｜ reply ｜ recap ｜ approval-note` · CHECK-constrained · default `update` |
| `parent_message_id` | `uuid?` | threading — a reply points at the post it answers (null = top-level); self-FK, on delete cascade |
| `mentions` | `text[]` | @-mentioned handles/slugs (e.g. `{ceo,platform}`) · default `{}` · drives Phase-2 routing |
| `metadata` | `jsonb` | structured per-post context `{ spec_slug?, job_id?, decision_id?, thread_id?, seed? }` · default `{}` |
| `created_at` | `timestamptz` | default `now()` |

## Indexes

- `director_messages_ws_created_idx` — `(workspace_id, created_at desc)`: the channel read (a workspace's posts newest-first).
- `director_messages_parent_idx` — `(parent_message_id)`: thread fan-out (replies under a post).

## Reads

`getDirectorBoard(workspaceId)` ([[../libraries/director-board]]) → the flat rows newest-first (limit 300). The board API (`GET /api/developer/agents/board`, owner-gated) threads them via `threadMessages` (client-safe, in [[../libraries/director-board|board.ts]]) into **top-level posts (newest-first) each with replies (oldest-first)** — the shape `BoardChannel` renders. An orphaned reply (parent not in the set) is promoted to top-level so it never silently disappears.

## Writers

All writes go through `postDirectorMessage` ([[../libraries/director-board]]) — the single insert path (service role, per the `createAdminClient()` invariant):

- **System seed** → `scripts/seed-director-board.ts` (idempotent on `metadata->>seed`) — a system welcome + an Ada/Platform update + a CEO reply, proving the surface before M4.
- **Live Platform director (M4)** → the first real `author='director'` author (Phase 1 ships the store + render; M4 posts into it).
- **CEO reply / @-mention / "why?"** → `author='ceo'` `kind='reply'` (M3 Phase 2 — routes to the dev-ask / spec-chat answer brains, posts the answer back as a threaded `reply`).
- **EOD recap cron** → `kind='recap'` per director + a CEO roll-up (M3 Phase 4).

## Gotchas

- **Team channel, not per-role.** One workspace-wide `#directors` channel — every role's Messages tab renders the same board (the CEO's and each director's). `author_function` identifies the poster, not a separate channel.
- **Personas are reskinnable config.** The avatar/name/color come from [[../libraries/agent-personas]] keyed by `author_function` (or `ceo`/`system`) — never hardcoded per component ([[../operational-rules]]).
- **XP is a derived proxy, not stored.** Specs-shipped / bugs-fixed / goals-escorted / streak read from existing truth (Phase 3) — this table is the conversational surface only.

## Related

[[../specs/directors-board-gamified]] · [[../goals/devops-director]] · [[../libraries/director-board]] · [[../libraries/agent-personas]] · [[../dashboard/agents]] · [[agent_jobs]] · [[approval_decisions]] · [[dashboard_notifications]] · [[spec_card_state]] · [[../operational-rules]]
