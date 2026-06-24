# ✅ Ada on Slack — chat with your CTO in #cto-ada

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform" (phone-first idea→spec→build, extended to phone-first founder↔CTO conversation)

Turn the existing CEO↔Director coaching flow into a **two-way Slack conversation with Ada** in a dedicated `#cto-ada` channel. The founder posts a natural message; Ada replies **as Ada — her own name and avatar** (not the "shopcx" bot), and when her answer warrants a durable change she posts a Block Kit **Approve / Reject** card. Approving runs the *same* `approve_action` path the web coach chat uses. No new Slack app, no new approval machinery, no new persona — we put a Slack front-end + Ada's face on `director_coach_threads` + `runDirectorCoachJob`.

**Why:** the founder already does "ask → (sometimes) plan/coach → approve" with Ada in the web UI, but the natural surface is Slack on a phone. Slack's per-message `username`/`icon_url` override (`chat:write.customize` scope) lets the one existing bot speak *as Ada* in this one channel while critical-alerts/daily-digest keep posting as "shopcx" everywhere else. North-star fit: Ada stays the supervised tool — every action she proposes is human-gated; Slack just moves the gate to the founder's pocket.

## Phase 1 — Ada persona on outbound Slack
- ✅ shipped
- **Slack app config (manual, one-time):** add the `chat:write.customize` scope to the ShopCX Slack app and re-auth so the workspace's `slack_bot_token_encrypted` carries it. Also add `reactions:write` (for the "thinking" ack, Phase 3). Document in the integration brain page.
- `src/lib/slack.ts`: add `postAsAda(token, channel, blocks, text, opts?)` — `chat.postMessage` with `username`/`icon_url` overridden to Ada's identity, returning the posted `ts` (so a card can be `chat.update`d later); `opts.thread_ts` threads the reply. Add `addReaction(token, channel, ts, name)` for the 👀 ack.
- Pull Ada's identity from a **single source** — `src/lib/agents/personas.ts` (`getPersona("platform")` → `name: "Ada"`, `avatarUrl` = her `agent-avatars/ada-platform.jpg`). Do **not** hardcode the avatar URL in `slack.ts`; import it from personas so it never drifts.
- Invariant check: `notify-ops-alert.ts`, `daily-digest-cron.ts`, and every `build*Message` dispatcher keep calling plain `postMessage` → still render as "shopcx". Only `postAsAda` overrides identity.

## Phase 2 — The #cto-ada channel + setup
- ✅ shipped
- Migration: add `slack_ada_channel_id text` (nullable) to `workspaces`.
- Setup affordance: a `/ada-here` slash command (owner-gated, registered in the Slack app) run **inside** the target channel captures `command.channel_id` → writes `slack_ada_channel_id` for the workspace. Zero UI. (Bot must be `/invite`d to `#cto-ada` first.)
- Setup doc: create `#cto-ada` → invite the bot → run `/ada-here` → bot replies "👋 This is now my channel, Dylan." as Ada.

## Phase 3 — Inbound: a #cto-ada message becomes a coach turn
- ✅ shipped
- `src/app/api/slack/events/route.ts`: add an `event.type === "message"` branch (requires subscribing the app to the `message.channels` bot event — manual Slack app step).
- **Loop guard (non-negotiable):** ignore the event if `event.bot_id` is set, if `event.subtype` exists (`bot_message`, `message_changed`, `message_deleted`, …), or if the author is the bot's own user id. Ada's own posts must never re-trigger her — else infinite loop.
- **Gate:** only act when `event.channel === workspace.slack_ada_channel_id` **and** the Slack user maps (email via `/api/slack/sync-members`) to an `owner` `workspace_member`. Non-owners in the channel are ignored.
- **Threading mirrors the web "new thread" model — keyed on Slack's `thread_ts`:**
  - A **top-level** post (no `event.thread_ts`, i.e. `thread_ts` is absent or equals the message's own `ts`) = a **new conversation** → `createThread`, and store `slack_thread_ts = event.ts` (that root message's ts is the Slack thread key once Ada replies into it).
  - A **threaded reply** (`event.thread_ts` set and matching an existing thread's `slack_thread_ts`) = **continue that same** `director_coach_thread` → `markThreadThinking(message)`, resuming its `box_session_id` so context persists. Ada always replies *into* the thread (Phase 5 posts with `thread_ts`), so a reply to one of her messages naturally stays in the same conversation.
  - A reply whose `thread_ts` maps to no known thread (e.g. an old pre-feature thread) → treat as a new conversation, keyed on that `thread_ts`.
- Stamp Slack origin on the thread row (Phase 5 columns: `source='slack'`, `slack_channel_id`, `slack_thread_ts`) so the box knows to post back into the right Slack thread.
- Enqueue `kind='director-coach'`, `mode='turn'`, `intent='auto'`.
- **Ack:** 200 immediately, then `reactions.add` 👀 on the founder's message so it reads as "received, thinking" during the box turn (the director-coach lane is concurrency-1 and runs a full Max session — seconds to ~2 min).

## Phase 4 — `intent='auto'` (Ada self-decides ask vs plan/coach/spec)
- ✅ shipped
- The web UI exposes three buttons (ask / coach / plan); Slack is one natural message. Add `intent='auto'` to `runDirectorCoachJob` (`scripts/builder-worker.ts`).
- Framing addition for `auto`: "This came from Slack as a natural message. Default to answering (ask). If your answer implies a durable coaching rule, an executable plan (directive), a new/edited spec, a proposed goal, or a model-tier change, ALSO emit the matching `pending_action` — exactly as if the CEO had pressed Coach/Plan."
- **No new card types** — reuse `coaching` / `spec` / `spec-edit` / `goal` / `directive` / `model_tier`. This is literally the "ask that becomes a plan/coach with approval" behavior, made automatic.

## Phase 5 — Outbound: post Ada's reply + approval cards to #cto-ada
- ✅ shipped
- Columns on `director_coach_threads`: `source text default 'web'`, `slack_channel_id text`, `slack_thread_ts text` (the Slack thread key — the root message ts; null for web threads). Per-action posted message ts is stashed on the pending_action object (below).
- In `runDirectorCoachJob`, after the existing finalize that writes `messages` + `pending_actions` to the thread (the `mode:'turn'` tail): if `source==='slack'`, post to `slack_channel_id` via `postAsAda`, **always threaded with `thread_ts = slack_thread_ts`** so her reply lands inside the founder's conversation (and a reply to it continues the same thread per Phase 3):
  1. Ada's plain-text `reply` — **plain text, no markdown, ≤2 sentences/paragraph** (house rule; it's her voice already).
  2. For each NEW `status:'pending'` action: a Block Kit **approval card** as Ada — a section rendering the action (summary/guidance/plan/spec slug) + `Approve` / `Reject` buttons, posted in the same thread. `action_id`s `ada_approve` / `ada_reject`; button `value` = JSON `{thread_id, actionId}`. Capture the posted message `ts` back onto the action so Phase 6 can `chat.update` it.

## Phase 6 — Block Kit Approve / Reject wiring
- ✅ shipped
- `src/app/api/slack/interactions/route.ts`: add `block_actions` handlers for `ada_approve` / `ada_reject`.
- **Re-gate:** the tapping Slack user must map to the `owner` — channel membership is not authorization. Reuse the same email→owner check (`resolveSlackActor`/`isOwner`).
- Approve → `setActionDecision(workspaceId, threadId, actionId, 'approve')` then enqueue `kind='director-coach'`, `mode='approve_action'` — the **identical** path `/api/director/coach` uses (writes the `director_instruction` / commits the spec / `proposeGoal` / activates the directive / routes the model-tier change). Reject → `setActionDecision(..., 'decline')`.
- `chat.update` the card (its stored `ts`) → replace the buttons with "✅ Approved — applying…" / "✕ Declined" so it's clear and not re-clickable (idempotent on repeat taps).
- When the `approve_action` job completes, post a short Ada confirmation in the thread ("Done — coaching rule saved." / "Spec queued: {slug}.").

## Phase 7 — Mirror every Slack conversation into the web director profile
- ✅ shipped
- The point: a Slack chat must appear in the ShopCX director coach chat **as if it happened there** — same transcript, same approval cards, same state. This is mostly free because Slack inbound writes to the *same* `director_coach_threads` table the web UI reads; the work is making it render natively and stay in sync both ways.
- **Ownership:** `createThread` for a Slack message sets `created_by`/`user_id` = the founder's **mapped `user_id`** (Slack user → email → `workspace_member.user_id`), so the thread shows up in his web `listRecentThreads` list. Confirm `listRecentThreads`/`loadThread` do **not** filter out `source='slack'` rows (they shouldn't — same shape).
- **Label:** render a small "via Slack 💬" badge on `source='slack'` threads in the web coach chat list/header so it's clear where the conversation lives — but it's fully readable + actionable in the web UI.
- **Bidirectional approvals (same row, two surfaces):**
  - Slack Approve/Reject → updates the thread row → the web card reflects approved/declined on next load (already true; same `setActionDecision`).
  - Web Approve/Reject on a `source='slack'` thread → also `chat.update` the corresponding Slack card (using the stashed message `ts`) to "✅ Approved" / "✕ Declined", so the Slack thread never shows stale buttons. (Add this to the web coach route's approve handler.)
- **Continuation across surfaces:** because both surfaces append to the same `messages[]` and resume the same `box_session_id`, the founder can start in Slack and continue in the web UI (or vice-versa) within the same thread seamlessly. (Web replies don't post to Slack as new messages — Slack mirrors the box's turn output; a web-only turn simply won't appear in Slack, which is acceptable. Note this asymmetry in the lifecycle page.)

## Phase 8 — Brain pages (CLAUDE.md hard rule)
- ✅ shipped
- `lifecycles/ada-slack-chat.md` — end-to-end trace (message → events route → coach turn → postAsAda → approve card → interactions → approve_action), with the Status/open-work block.
- Update `integrations/slack.md` — `chat:write.customize` + `reactions:write` scopes, `message.channels` subscription, the persona override, the `/ada-here` command.
- Update `libraries/slack.md` — `postAsAda`, `addReaction`.
- Update `tables/director_coach_threads.md` — `source`, `slack_channel_id`, `slack_thread_ts`.
- Update `tables/workspaces.md` — `slack_ada_channel_id`.
- Cross-link all + run `brain:index`.

## Safety / invariants
- **Persona override is scoped to `postAsAda` only.** Critical alerts (`#alerts-critical`) and the daily digest (`#daily-digest`) keep posting as "shopcx". The override is per-message; it never touches the app's global profile.
- **Loop guard is mandatory.** Drop any message event with `bot_id`/`subtype`/own-user-id before doing anything. Ada answering Ada is an infinite loop.
- **Owner-only, re-checked on BOTH surfaces.** Only the founder's email-mapped `owner` Slack user can talk to Ada *and* approve cards. Never trust `#cto-ada` channel membership as authorization.
- **No new mutation path.** Slack approvals run the exact `setActionDecision` + `approve_action` code the web coach chat runs — same leash, same gates. Ada never self-applies; the founder approves in Slack. (North star: Ada is the supervised tool; the gate just moved to the founder's pocket.)
- **Plain text, no markdown** in Ada's Slack prose; Block Kit only for the structured approval cards.
- One thread per Slack conversation (keyed on `thread_ts`); reuse the box-session resume rather than re-feeding the whole transcript each turn.

## Completion criteria
- Founder posts in `#cto-ada` → Ada replies **in-channel as "Ada" with her avatar** within the box turn's latency, having actually read the relevant brain/roadmap/queue state.
- A top-level post starts a new thread; a reply inside Ada's thread continues the same conversation (same `box_session_id`).
- A message that warrants it yields an Approve/Reject card; **Approve** applies via the existing `approve_action` path and Ada confirms; **Reject** dismisses with no write.
- The conversation is visible + actionable in the web director coach chat (same thread), badged "via Slack".
- `#alerts-critical` and `#daily-digest` still post as "shopcx" (persona override didn't leak).
- Non-owner in `#cto-ada` is ignored; bot's own messages never re-trigger a turn.

## Verification
- On `#cto-ada` after setup, post "why haven't you built the spec-lifecycle-and-archival spec?" → expect an in-channel reply authored by **Ada** (her name + avatar, not shopcx) that names the real blocker/phase/owner, within ~2 min, with a 👀 reaction on your message while she thinks.
- On `#cto-ada`, reply inside Ada's thread with a follow-up → expect she answers in the same thread with context from the prior turn (no new thread spawned; check `director_coach_threads` — same row updated).
- On `#cto-ada`, post "from now on auto-approve additive backfills that pass a read-only check" → expect Ada to reply AND post an Approve/Reject **coaching** card. Tap **Approve** → expect the card to update to "✅ Approved — applying…", a `director_instruction` to be written (visible in the web coach chat / `agent_instructions`), and an Ada "Done" confirmation in the thread.
- On `#cto-ada`, tap **Reject** on a card → expect "✕ Declined" and no `director_instruction`/spec/goal written.
- On `/dashboard` director coach chat, open the thread started from Slack → expect the full transcript + cards rendered, badged "via Slack", and approving a card there flips the Slack card to "✅ Approved" too.
- Trigger a critical ops alert and wait for the daily digest → expect both to still post as **"shopcx"** (override scoped to Ada).
- As a non-owner workspace member, post in `#cto-ada` → expect no response from Ada.
- Confirm Ada's own posts in `#cto-ada` do not spawn new `kind='director-coach'` jobs (check `agent_jobs` — one job per *founder* message only).
