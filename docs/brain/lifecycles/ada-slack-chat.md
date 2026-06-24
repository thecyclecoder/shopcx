# Lifecycle: Ada on Slack (#cto-ada)

Two-way chat with **Ada** (the Platform/CTO director) in a dedicated `#cto-ada` Slack channel. The founder posts a natural message; Ada replies **as Ada — her own name + avatar** (not the "shopcx" bot), and when her answer warrants a durable change she posts a Block Kit **Approve / Reject** card. This is a **Slack front-end onto the existing [[../libraries/director-coach-threads]] flow** — the same `director_coach_threads` rows, the same `runDirectorCoachJob` box turn, the same gated `approve_action` execution. No new Slack app, no new approval machinery, no new persona.

Spec: [[../specs/ada-slack-chat]] (until folded). Owner: [[../functions/platform]].

## The cast of moving parts

| Piece | Where |
|---|---|
| `postAsAda` / `addReaction` / `postMessage(…, {thread_ts})` | [[../libraries/slack]] (`src/lib/slack.ts`) |
| Ada's Slack identity (name + avatar) | `ADA_SLACK_IDENTITY` ← `getPersona("platform")` ([[../libraries/agent-personas]]) |
| Approval-card Block Kit | `src/lib/slack-ada.ts` — `buildAdaApprovalCard` / `buildAdaResolvedCard` / `ADA_ACTIONS` |
| Inbound message + `/ada-here` | `src/app/api/slack/events/route.ts` |
| Approve / Reject taps | `src/app/api/slack/interactions/route.ts` (`ada_approve` / `ada_reject`) |
| The box turn (intent `auto`) + outbound post | `runDirectorCoachJob` in `scripts/builder-worker.ts` |
| Web mirror (relay + card-resolve) | `src/app/api/director/coach/route.ts` |
| Thread state | [[../tables/director_coach_threads]] (`source`, `slack_channel_id`, `slack_thread_ts`) + [[../tables/workspaces]] (`slack_ada_channel_id`) |

## Setup (one-time)

1. **Slack app config** (manual): add scopes `chat:write.customize` (post as Ada) + `reactions:write` (the 👀 ack) **+ the history scope for the channel type you'll use** — `channels:history` for a public `#cto-ada`, **`groups:history` for a private one**. Subscribe the bot to the matching message event — **`message.channels` (public) or `message.groups` (private)**. Register the `/ada-here` slash command. Re-auth so the workspace's encrypted bot token carries the new scopes.
   - ⚠️ **Receiving ≠ posting.** Being a member + `chat:write` lets the bot *post* to a private channel (that's all `#alerts-critical`/`#daily-digest` ever needed) but does **not** let it *read* messages — that requires the channel-type `*:history` scope + the matching `message.*` subscription. See the gotcha in [[../libraries/slack]]. A private channel needs `groups:history` + `message.groups`; the bot's `groups:read/write` are not enough.
2. Create `#cto-ada`, `/invite` the bot, then run **`/ada-here`** inside it → writes `workspaces.slack_ada_channel_id`. Ada confirms in-channel: "👋 This is now my channel."

## Happy path — founder asks, Ada answers

```
Founder posts in #cto-ada
  → POST /api/slack/events  (event.type='message')
      • loop guard: drop if bot_id / subtype / Slack retry  ← never answer Ada's own posts
      • channel gate: event.channel === workspaces.slack_ada_channel_id
      • owner gate:   slack user → email → owner workspace_member  (resolveSlackActor/isOwner)
      • threading (keyed on Slack thread_ts):
          top-level post  → createThread(source='slack', slack_thread_ts = event.ts)
          reply in thread → findThreadBySlackThreadTs → markThreadThinking (same box session)
      • enqueue agent_jobs kind='director-coach' {mode:'turn', intent:'auto'}
      • reactions.add 👀 on the founder's message
  → box claims the director-coach job (concurrency-1 lane)
      • runDirectorCoachJob runs a resumable Max session AS Ada, READ-ONLY (brain + leash + roadmap)
      • intent='auto': default to ASK; ALSO emit ONE pending_action iff the answer implies a durable change
      • finalize: postCoachTurnToSlack → postAsAda (threaded) the reply + a card per new action,
                  stamping each action with its Slack message ts
  → Ada's reply appears in the #cto-ada thread, as Ada
```

## Approval path — a card that warrants a change

```
Ada posts an Approve / Reject card (as Ada, in-thread)
  → founder taps Approve
      → POST /api/slack/interactions  (block_actions: ada_approve)
          • owner re-gate (channel membership is NOT authorization)
          • setActionDecision(approve)                ← the SAME call the web coach chat uses
          • chat.update the card → "✅ Approved — applying…"  (not re-clickable)
          • enqueue agent_jobs {mode:'approve_action'}  ← the SAME box executor as the dashboard
  → box runs approve_action: writes the director_instruction / commits the spec / proposeGoal /
    activates the directive / routes the model-tier change — then postAsAda "Done: …" in the thread
```

Reject → `setActionDecision(decline)` + `chat.update` → "✕ Declined", no write.

## Web ⇄ Slack mirror — one conversation, two windows

A `source='slack'` thread is the **same row** the web director-coach chat reads, so the conversation is visible + actionable on both surfaces and stays in sync:

- **Ada's replies** mirror to Slack from the box (`postCoachTurnToSlack`) regardless of where the turn was initiated.
- **A web-typed reply** on a Slack thread is **relayed into the Slack thread** (`relayCeoMessageToSlack`) — clearly marked "💬 {name} replied from ShopCX" (Slack forbids a bot posing as a real user, so it's an honest relay, not impersonation).
- **A web-side Approve/Reject** also `chat.update`s the Slack card (`resolveSlackCardFromWeb`) so the Slack thread never shows stale buttons.
- The web coach chat tags a Slack-origin thread with a **"via Slack 💬"** chip.
- Both surfaces append to the same `messages[]` and resume the same `box_session_id`, so the founder can start in Slack and continue on the web (or vice-versa) seamlessly.

## Safety / invariants

- **Persona override is scoped to `postAsAda` only.** `#alerts-critical` (ops alerts) + `#daily-digest` keep posting as "shopcx"; the `chat:write.customize` override is per-message, never the app's global profile.
- **Loop guard is mandatory** — drop any message with `bot_id`/`subtype`, and skip Slack retry redeliveries. Ada answering Ada is an infinite loop.
- **Owner-only on BOTH surfaces** — only the founder's email-mapped `owner` may talk to Ada and approve cards.
- **No new mutation path** — Slack approvals run the exact `setActionDecision` + `approve_action` code the dashboard runs (same leash, same gates). Ada never self-applies; the gate just moved to the founder's pocket. (North-star supervisable autonomy — [[../operational-rules]].)

## Status / open work

**Shipped:** the end-to-end loop above — `/ada-here` setup, inbound message → coach turn (`intent='auto'`), Ada replies as herself threaded in `#cto-ada`, Approve/Reject cards run the existing `approve_action` path, and full web⇄Slack mirroring (relay + card-resolve + badge).

**Known gaps / not yet shipped:**
- The Slack app scopes/subscription/`/ada-here` command are **manual console config** (can't be automated from code).
- A brand-new conversation started on the *web* has no Slack thread, so it doesn't appear in `#cto-ada` (mirroring is for threads that already live in Slack). Reverse direction (Slack→web) is always mirrored.
- Web-only turns on a Slack thread mirror Ada's reply + relay the CEO line, but a purely web `retry` doesn't re-relay.

**Open questions:** None.

## Related

[[../libraries/director-coach-threads]] · [[../tables/director_coach_threads]] · [[../tables/workspaces]] · [[../libraries/slack]] · [[../functions/platform]] · [[../specs/ada-slack-chat]] · [[roadmap-build-console]] · [[../operational-rules]]
