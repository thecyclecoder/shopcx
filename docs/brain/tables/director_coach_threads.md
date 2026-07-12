# director_coach_threads

The **CEO↔Director coaching chat** thread — a resumable Max conversation where the CEO asks the Platform/DevOps Director (Ada) about her decisions ("why haven't you built spec X?"), she explains read-only, and the CEO coaches her. The conversational top rung of the cascade ([[../specs/worker-grading-and-director-management]] Phase 7). Mirrors [[dev_message_threads]] one level up — each turn enqueues a `kind='director-coach'` [[agent_jobs]] row the box runs as a `claude -p` Max session AS the director.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `user_id` | `uuid` | ✓ | the CEO/owner who started the thread |
| `director_function` | `text` | — | the director being coached (default `platform`). Since the [[../lifecycles/director-cockpits]] goal (M1) this spans **every live director** — `platform`｜`growth`｜`cs`｜`logistics` — not just Ada; the value picks the persona + leash the box turn runs as. |
| `title` | `text` | ✓ | first message, truncated |
| `messages` | `jsonb` | — | `[{role:'user'｜'assistant', content}]` — the conversation · default `[]` |
| `box_session_id` | `text` | ✓ | the resumable `claude -p` session id (null until turn 1); the box `--resume`s it each turn |
| `turn_status` | `text` | — | `idle｜thinking｜error` · default `idle` (the UI polls this) |
| `last_error` | `text` | ✓ | surfaced on `error` |
| `pending_actions` | `jsonb` | — | gated cards: a `coaching` amendment or a `spec` handoff · default `[]` |
| `source` | `text` | — | `web` (default) ｜ `slack` — a `slack` thread is a [[../lifecycles/ada-slack-chat\|#cto-ada]] conversation, mirrored into this same web profile |
| `slack_channel_id` | `text` | ✓ | the `#cto-ada` channel a `slack` thread posts Ada's reply + cards back to |
| `slack_thread_ts` | `text` | ✓ | the Slack thread root ts — the conversation key; a founder reply carrying this `thread_ts` continues the same thread |
| `metadata` | `jsonb` | — | per-thread structured context · default `{}` — a chat-mode invitation thread ([[../specs/ada-slack-routed-approvals]] Phase 3) carries `{chat_mode:true, agent_job_id, notification_id, spec_slug, kind, investigation}` so the box turn knows which routed approval the conversation is about without re-deriving it |
| `cockpit_token` | `text` | ✓ | **SMS cockpit (M4).** 48-hex token minted by `armDirectorCockpit` so the `/god/[token]` surface can resolve this thread to a phone cockpit bound to the director's leash. Null until armed; nulled on disarm. DISJOINT from `god_mode_sessions.cockpit_token` — [[../libraries/cockpit-resolver]] is the single resolver chokepoint. |
| `token_expires_at` | `timestamptz` | ✓ | sliding TTL on the cockpit token (bumped each turn) — mirrors `god_mode_sessions` |
| `absolute_expires_at` | `timestamptz` | ✓ | hard TTL ceiling — a token past either TTL resolves to null |
| `sms_notified_at` | `timestamptz` | ✓ | stamps the last 5-min approval-nudge SMS so `nudgeStaleDirectorApprovals` never re-texts the same pending card |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Pending-action shapes:** `{type:'coaching', summary, errorClass, guidance, triggeringPattern, reasoning, status}` (on approval the worker writes a [[director_instructions]] row via `coachDirector`); `{type:'spec', summary, slug, title, owner, parent, content, queueBuild, status}` (committed on approval). Slack-posted cards also carry `slackTs` (the card's Slack message ts) so a web-side OR Slack-side decision can `chat.update` it in place. The model NEVER executes — `runDirectorCoachJob` mode `approve_action` does, on the CEO's click.

**Index:** `(workspace_id, user_id, updated_at desc)` (the resume list) · `(workspace_id, slack_thread_ts) WHERE slack_thread_ts IS NOT NULL` (continue a #cto-ada thread) · **unique `(cockpit_token) WHERE cockpit_token IS NOT NULL`** so [[../libraries/cockpit-resolver]] can resolve an SMS-cockpit token by itself (null tokens coexist freely).

## SMS cockpit (M4)
The `cockpit_token` + TTL + `sms_notified_at` columns make this row a **phone cockpit bound to ONE director's leash**, reusing Eve's `/god/[token]` surface end-to-end. `armDirectorCockpit` mints the token + fires a persona-named arm SMS through `sendGodModeSMS`; `resolveDirectorCockpitToken` (behind [[../libraries/cockpit-resolver]] `resolveCockpitTokenAny`) resolves it or returns null on unknown/wrong-length/expired. The cockpit runs the read-only `max` sandbox (never Eve's `godmode`) and PIN-gates exactly the rails the in-app chat does. See [[../lifecycles/director-cockpits]] § SMS cockpit.

**Chat-mode invitation threads** ([[../specs/ada-slack-routed-approvals]] Phase 3): a complex routed CEO approval (multi-choice action, brain-touching kind like `proposed-goal`/spec, or a >1200-char investigation preview) opens a Slack thread instead of a Block Kit Approve/Reject card. The thread is created from the box reconciler via `createChatModeInvitationThread` with `source='slack'`, the post's ts as `slack_thread_ts`, the workspace owner as `user_id`, and `metadata` pre-seeded with the approval's context. The opening assistant message is Ada's invitation ("…paused for your call. …Want to walk through it?"); a founder reply in the Slack thread becomes a regular `intent='auto'` coach turn via the existing events handler.

## The turn/intent model
The CEO's two buttons set `intent` on a turn (in the job `instructions`): **Ask** (`intent='ask'` — she explains, never emits a coaching card) vs **Coach her** (`intent='coach'` — she distills the directive into a `coaching` card for confirmation). A **Plan** turn (`intent='plan'`) hands her a directive. The approval card is the explicit confirmation, so a multi-turn convo stays conversation until the CEO presses Coach.

**`intent='auto'` (Slack):** a `#cto-ada` message has no buttons, so the box self-decides — it defaults to Ask and *also* emits the one matching card (coaching/spec/spec-edit/goal/directive/model_tier) only when the answer implies a durable change. Same cards, same gates; see [[../lifecycles/ada-slack-chat]].

## RLS
Authenticated SELECT (owner-gated at the route/UI), service-role write — mirror [[dev_message_threads]].

## Migration
`supabase/migrations/20260705140000_director_coaching.sql` (apply: `npx tsx scripts/apply-director-coaching-migration.ts`). Creates this + [[director_instructions]] + [[director_coaching_log]]. Idempotent. The `source` / `slack_channel_id` / `slack_thread_ts` columns are added by `20260707120000_ada_slack_chat.sql` (apply: `npx tsx scripts/apply-ada-slack-chat-migration.ts`). The SMS-cockpit columns (`cockpit_token` / `token_expires_at` / `absolute_expires_at` / `sms_notified_at`) + the unique cockpit-token index are added by `20261015120000_director_cockpit_token.sql` (additive + nullable — safe to apply ahead of the SDK).

---

[[../README]] · [[director_instructions]] · [[director_coaching_log]] · [[dev_message_threads]] · [[agent_jobs]] · [[../libraries/director-coach-threads]] · [[../libraries/cockpit-resolver]] · [[../lifecycles/director-cockpits]] · [[../lifecycles/ada-slack-chat]] · [[../specs/worker-grading-and-director-management]] · [[../../CLAUDE]]
