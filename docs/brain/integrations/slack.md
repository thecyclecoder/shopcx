# Slack integration

OAuth + Events API for workspace chat integration. The bot posts to channels (daily digest, ops alerts, escalations, ticket notifications) and receives messages in the dedicated `#cto-ada` channel for two-way conversation with Ada, the Platform Director.

**Key credential:** `workspaces.slack_bot_token_encrypted` (AES-256-GCM) — bot OAuth token minted at `https://api.slack.com/apps/` and re-authorized whenever scopes change.

## OAuth setup (one-time)

1. Create a Slack app at https://api.slack.com/apps — workspace-bound (each tenant gets one app).
2. **Basic info:** display name (e.g., "ShopCX Ada"), icon, description.
3. **OAuth scopes** → `Bot Token Scopes`:
   - **Always required:** `chat:write` (post to channels/DMs), `reactions:write` (add emoji reactions), `users:lookupByEmail` (map founder email to Slack user).
   - **For `#cto-ada` posting as Ada:** `chat:write.customize` (override bot username + avatar via `username` + `icon_url`).
   - **For inbound messages in `#cto-ada`** (receiving, not just posting):
     - Public `#cto-ada`: **`channels:history`** + subscribe to **`message.channels`** event.
     - Private `#cto-ada`: **`groups:history`** + subscribe to **`message.groups`** event.
   - ⚠️ **Gotcha:** posting to a private channel only needs `chat:write` (why `#alerts-critical` and `#daily-digest` worked pre-Ada). **Receiving** messages needs the channel-type-specific history scope + matching event subscription — see [[../libraries/slack]] gotcha.

4. **Slash commands** → Register `/ada-here` (scope: none; no URL needed — it's handled in the events route as a `.command` subtype):
   - Command: `/ada-here`
   - Request URL: (leave blank, handled internally)
   - Short description: `Set this channel as my Ada workspace`

5. **Event Subscriptions:**
   - Request URL: `POST https://{shopcx.ai}/api/slack/events` (use local ngrok tunnel for testing).
   - Verify token (Slack will POST a challenge; our route signs and echoes it).
   - **Subscribe to events:**
     - `message.channels` (public channel messages; needed if `#cto-ada` is public).
     - `message.groups` (private channel messages; needed if `#cto-ada` is private).
     - `app_mention` (legacy; kept for future roadmap home use).
     - `app_home_opened` (App Home renders on first visit; see [[slack-home]]).

6. **Interactive components:**
   - Request URL: `POST https://{shopcx.ai}/api/slack/interactions` (block_actions like Ada's Approve/Reject buttons).
   - Verify token.

7. **Permissions** → Find **Signing Secret** (`SLACK_SIGNING_SECRET` in env), used by `verifySlackSignature`.

8. **Reinstall app** → get new bot token with the updated scopes. The token (`xoxb-…`) is stored in `workspaces.slack_bot_token_encrypted`.

## Setup per workspace (one-time, owner op)

1. Navigate to Slack → Apps → your ShopCX app → **Install to workspace** (if not already installed).
2. In Slack, create a channel `#cto-ada` (public or private).
3. Run `/invite` (Slack native) to add the bot to `#cto-ada`.
4. Run `/ada-here` *inside* `#cto-ada` → the slash-command route (`POST /api/slack/events` subtype `slash_commands`) captures `event.channel_id`, writes `workspaces.slack_ada_channel_id`, and Ada replies "👋 This is now my channel, {name}."

## Posting (outbound)

- **Plain posts** (`postMessage`) — appears as "shopcx" bot. Used by daily digest, ops alerts, ticket notifications, etc.
- **Ada posts** (`postAsAda`) — appears as **Ada** (her name + avatar from `getPersona("platform")`), **only** for `#cto-ada` replies. The override is per-message via `chat:write.customize`, never the app's global profile, so other channels stay "shopcx".

## Receiving (inbound)

The events route (`POST /api/slack/events`) handles:

1. **Challenge verification** — Slack sends a challenge on first subscription; we sign + echo it.
2. **Slash commands** (`/ada-here`, `type: "slash_commands"`) — capture channel ID, set `slack_ada_channel_id`, respond as Ada.
3. **Message events** (`event.type === "message"`):
   - **Loop guard:** ignore if `bot_id` is set, `subtype` exists (bot_message, message_changed, etc.), or sender is the bot's own user. Ada's own posts must never trigger her.
   - **Channel gate:** only act if `event.channel === workspaces.slack_ada_channel_id`.
   - **Owner gate:** map Slack user email → owner `workspace_member` (via `resolveSlackActor`, mirrored from team-sync). Non-owners in the channel are silently ignored.
   - **Threading:** keyed on Slack's `thread_ts`. Top-level post → new `director_coach_thread` (source='slack', store `slack_thread_ts = event.ts`). Reply in thread → find existing thread by `slack_thread_ts`, resume its `box_session_id`. Treat stale/orphaned `thread_ts` as new conversation.
   - **Ack + enqueue:** `reactions.add` 👀 on the message (shows "thinking"), enqueue `kind='director-coach'` job (`mode='turn', intent='auto'`).

## Posting Ada's reply back (outbound after coach turn)

After `runDirectorCoachJob` completes:
- Post Ada's plain-text reply to the thread via `postAsAda(…, {thread_ts: slack_thread_ts})` (threaded, as Ada).
- For each new `status='pending'` action (coaching rule / spec / plan / directive / goal / model-tier change):
  - Post a Block Kit approval card (as Ada, threaded) with Approve / Reject buttons (`ada_approve` / `ada_reject` action_ids, value = JSON `{thread_id, actionId}`).
  - Stamp each action with its posted `ts` so the interactions route can `chat.update` it later.

## Handling approvals (inbound interactions)

The interactions route (`POST /api/slack/interactions`, `block_actions`) handles:
- **Gate:** only the Slack user mapped to the owner may tap buttons (channel membership ≠ authorization; re-check email → owner).
- **Approve** → `setActionDecision(approve)`, `chat.update` card → "✅ Approved — applying…", enqueue `kind='director-coach' mode='approve_action'`.
- **Reject** → `setActionDecision(decline)`, `chat.update` card → "✕ Declined".

When `approve_action` job completes, post Ada's brief confirmation ("Done — coaching rule saved." / "Spec queued: {slug}.").

## Related

[[../libraries/slack]] · [[slack-notify]] · [[slack-home]] · [[../lifecycles/ada-slack-chat]] · [[../tables/director_coach_threads]] · [[../tables/workspaces]]

---

[[../README]] · [[../../CLAUDE]]
