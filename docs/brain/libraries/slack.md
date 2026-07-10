# libraries/slack

Slack OAuth + API client for workspace integrations.

**File:** `src/lib/slack.ts`

## File header

```
Slack API client — bot token per workspace, Block Kit message builders
```

## Exports

### `getSlackToken` — function

```ts
async function getSlackToken(workspaceId: string) : Promise<string | null>
```

### `isSlackConnected` — function

```ts
async function isSlackConnected(workspaceId: string) : Promise<boolean>
```

### `postMessage` — function

```ts
async function postMessage(token: string, channel: string, blocks: unknown[], text: string, opts?: { thread_ts?: string }) : Promise<boolean>
```

THE chokepoint for every Slack channel/DM post (daily digest, ops alerts, ticket notifications all go through it). On each successful send it beats the **`slack-delivery`** Control Tower loop (`reactive`, 28h liveness window) — ONE monitor for all Slack comms instead of per-channel cron monitors. A sustained delivery outage stops the beats → the monitor flags it; the daily digest guarantees a beat every ~24h. Throttled to ≤1 beat/5 min, fire-and-forget. `opts.thread_ts` posts into a thread (used to relay a web reply into a `#cto-ada` thread — [[../lifecycles/ada-slack-chat]]).

### `postAsAda` — function

```ts
async function postAsAda(token: string, channel: string, blocks: unknown[], text: string, opts?: { thread_ts?: string }) : Promise<{ ok: boolean; ts?: string }>
```

Post a message **as Ada** — her name + avatar — via the `chat:write.customize` override (`ADA_SLACK_IDENTITY` ← `getPersona("platform")`). Used **only** by the `#cto-ada` chat ([[../lifecycles/ada-slack-chat]]); every other caller uses plain `postMessage` and stays "shopcx", so the persona override never leaks to ops alerts / the daily digest. Returns the posted `ts` so an approval card can be `chat.update`d later; `opts.thread_ts` threads the reply.

### `postAsGrowthDirector` — function

```ts
async function postAsGrowthDirector(token: string, channel: string, blocks: unknown[], text: string, opts?: { thread_ts?: string }) : Promise<{ ok: boolean; ts?: string }>
```

Post a message **as the Growth Director (Max)** — his name + avatar — via the `chat:write.customize` override (`GROWTH_DIRECTOR_SLACK_IDENTITY` ← `getPersona("growth")`). Used **only** by [[media-buyer-director-digest]] to post rolled-up media-buyer cohort recommendations into `#director-growth-max` ([[../specs/media-buyer-director-slack-digest]] Phase 2). Mirrors the `postAsAda` pattern for director-voice posts that need persona override. Returns the posted `ts` so a caller can update later; `opts.thread_ts` threads the reply.

### `addReaction` — function

```ts
async function addReaction(token: string, channel: string, ts: string, name: string) : Promise<boolean>
```

Add an emoji reaction (`reactions.add`) — the 👀 "received, thinking" ack on a founder's `#cto-ada` message while the box runs. `already_reacted` is treated as a benign no-op.

### `lookupUserByEmail` — function

```ts
async function lookupUserByEmail(token: string, email: string) : Promise<string | null>
```

### Inbound helpers

Originally added for the first inbound Slack surface (the since-removed Slack roadmap console).

```ts
function verifySlackSignature(rawBody: string, signature: string | null, timestamp: string | null) : boolean
async function resolveWorkspaceByTeamId(teamId: string) : Promise<string | null>
async function findChannelByName(token: string, name: string) : Promise<string | null>
async function openModal(token: string, triggerId: string, view: unknown) : Promise<boolean>
async function publishHomeView(token: string, slackUserId: string, view: unknown) : Promise<boolean>
async function postEphemeral(token: string, channel: string, user: string, blocks: unknown[], text: string) : Promise<boolean>
async function updateMessage(token: string, channel: string, ts: string, blocks: unknown[], text: string) : Promise<boolean>
```

`publishHomeView` — `views.publish` for a user's App **Home tab** (`view` is a `{ type: "home", blocks }` view). Used by [[slack-home]] for the roadmap Home tab.

`verifySlackSignature` — HMAC-SHA256 over `v0:{ts}:{body}` keyed by `SLACK_SIGNING_SECRET`, rejecting > 5 min timestamp skew (replay guard). Pass the **raw** unparsed body.

### `listChannels` — function

```ts
async function listChannels(token: string) : Promise<{ id; name; is_private }[]>
```

Merges **`conversations.list`** (`public_channel`) **+ `users.conversations`** (`public_channel,private_channel` — the bot's own memberships), deduped by id. The `users.conversations` half is required because **`conversations.list` does not return a bot's PRIVATE channels** even with `groups:read` + the bot invited (verified 2026-06-19) — without it a name-based lookup never finds a private channel. Used by the Slack settings channel dropdown, ticket-share, and `findChannelByName`.

> **Gotcha — POSTING to a private channel ≠ RECEIVING messages from it (different scopes + events).** (verified 2026-06-24, [[ada-slack-chat]] inbound debug.) Slack splits these:
> - **Posting (outbound)** — `postMessage`/`postAsAda` to a private channel needs only **`chat:write`** + the bot being a **member**. This is why `#alerts-critical` + `#daily-digest` (both private, post-only) have always worked with no history scope.
> - **Receiving message events (inbound)** — to get a member's messages from a channel via the Events API you need the **channel-type-specific `*:history` scope AND the matching `message.*` event subscription**, even if the bot is already a member:
>
> | Channel type | Event to subscribe | Scope required |
> |---|---|---|
> | Public | `message.channels` | `channels:history` |
> | **Private** | **`message.groups`** | **`groups:history`** |
> | DM | `message.im` | `im:history` |
> | Group DM | `message.mpim` | `mpim:history` |
>
> `message.channels` does **not** fire for a private channel — Slack delivers private-channel messages only as `message.groups`. So a private `#cto-ada` needs **both** `groups:history` (the bot has `groups:read/write` but those are NOT enough) **and** the `message.groups` subscription, then a **reinstall + reconnect** (the new scope mints a fresh bot token our DB must re-store). The route handler is channel-type-agnostic — it gates on `event.channel === slack_ada_channel_id` and reads `event.type === "message"`, which both `message.channels` and `message.groups` carry — so only the Slack-app config differs, never the code. This bit Ada because she's the **first** feature that *reads* a channel; every prior Slack use was post-only or slash-commands/App-Home (no history scope needed).

> **Gotcha — Slack webhook endpoints must be in middleware `PUBLIC_ROUTES`.** Slack POSTs to `/api/slack/interactions` (Block Kit buttons / modals) and `/api/slack/events` (e.g. `app_home_opened`) **server-to-server with no session cookie**. The auth is the **signing-secret verification inside each route**, not a web session — so they must be listed in `PUBLIC_ROUTES` (`src/lib/supabase/middleware.ts`). Omitting them makes the middleware **307-redirect to `/login`**, which Slack surfaces as **"This app responded with Status Code 405"** (verified 2026-06-19 on the Squash & merge button). The OAuth `/api/slack/callback` does *not* need it — the browser carries the session there.

### View helpers — `openModal` · `updateModal` · `publishHomeView`

`openModal(token, triggerId, view)` (`views.open`) opens a Block Kit modal from a `block_actions` `trigger_id` — how the App Home spec-detail modal ([[slack-home]] `buildSpecModal`) is shown. `updateModal(token, viewId, view)` (`views.update`) replaces an open modal in place — used to reflect a build/verify action taken from inside that modal. `publishHomeView(token, slackUserId, view)` (`views.publish`) writes the App Home tab. All return-on-error (`false`), never throw.

> **Retired (2026-06-19):** the native **Slack List** roadmap mirror (`slackLists.*` wrappers, `lists:read/write` scopes, `workspaces.slack_roadmap_list`) was removed by [[../specs/slack-home-detail]] — the App Home tab + its spec-detail modal is now the single in-Slack destination, so the List and its extra scopes are gone.

### `autoMapTeamMembers` — function

```ts
async function autoMapTeamMembers(workspaceId: string) : Promise<
```

### `exchangeCodeForToken` — function

```ts
async function exchangeCodeForToken(code: string) : Promise<
```

### `saveSlackConnection` — function

```ts
async function saveSlackConnection(workspaceId: string, botToken: string, teamId: string, teamName: string,) : Promise<void>
```

### `disconnectSlack` — function

```ts
async function disconnectSlack(workspaceId: string) : Promise<void>
```

### `buildEscalationMessage` — function

```ts
function buildEscalationMessage(data: { ticketId: string; ticketNumber?: string; customer: { name?: string; email?: string }; reason: string; assignedTo?: string; }) :
```

### `buildChargebackMessage` — function

```ts
function buildChargebackMessage(data: { ticketId?: string; customer: { name?: string; email?: string }; amount: string; reason: string; orderId?: string; }) :
```

### `buildFraudMessage` — function

```ts
function buildFraudMessage(data: { customer: { name?: string; email?: string }; severity: string; rules?: string[]; reason?: string; orderId?: string; caseId?: string; }) :
```

### `buildDunningMessage` — function

```ts
function buildDunningMessage(data: { customer: { name?: string; email?: string }; subscriptionId?: string; attempts: number; ticketId?: string; }) :
```

### `buildCsatMessage` — function

```ts
function buildCsatMessage(data: { ticketId: string; ticketNumber?: string; customer: { name?: string; email?: string }; score: number; comment?: string; }) :
```

### `buildCancelMessage` — function

```ts
function buildCancelMessage(data: { ticketId?: string; customer: { name?: string; email?: string }; reason?: string; }) :
```

### `buildPartialRefundMessage` — function

```ts
function buildPartialRefundMessage(data: { ticketId?: string; customer: { name?: string; email?: string }; amount: string; reason?: string; orderNumber?: string; }) :
```

### `buildNewTicketMessage` — function

```ts
function buildNewTicketMessage(data: { ticketId: string; ticketNumber?: string; customer: { name?: string; email?: string }; channel: string; subject?: string; }) :
```

## Callers

- `src/app/api/slack/callback/route.ts`
- `src/app/api/slack/channels/route.ts`
- `src/app/api/slack/disconnect/route.ts`
- `src/app/api/slack/sync-members/route.ts`
- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts`
- `src/lib/slack-notify.ts` · `src/lib/slack-home.ts` · `src/lib/slack-identity.ts`

## Fetch hardening (`slackFetch`)

Every Slack API call goes through a private `slackFetch(url, init)` wrapper (added by [[../specs/slack-fetch-timeout-hardening]]):

- **Per-request timeout** — `AbortSignal.timeout(SLACK_TIMEOUT_MS = 5000)`. On timeout `fetch` rejects with a `TimeoutError`, which propagates to the caller's `try/catch`. This is the fix for a per-minute Slack cron hang: an un-timed fetch against a slow Slack endpoint froze the cron past Inngest's budget (killed before `emitCronHeartbeat`), going freshness-red. A thrown error still lets the heartbeat fire — one slow tick, not an open-ended outage.
- **Bounded 429 retry** — on HTTP 429 it honors `Retry-After` capped at `SLACK_MAX_RETRY_WAIT_MS = 3000`, up to `SLACK_MAX_RETRIES = 2` times, then returns the 429 response.
- **Pagination cap** — `listChannels`' `collect` loop is bounded by `SLACK_MAX_PAGES = 20` (× `limit:200` = 4000 channels) so a never-emptying `next_cursor` can't fetch forever.

`slackFetch` throws on timeout/network error (fail fast); the `result.ok` checks still handle Slack-level API errors as before.

## Gotchas

- **Inbound signature verification needs the raw body.** Read `await request.text()` and verify **before** parsing — verifying a re-serialized body fails the HMAC.

## Related

[[slack-home]] · [[slack-identity]] · [[slack-notify]]

---

[[../README]] · [[../../CLAUDE]]
