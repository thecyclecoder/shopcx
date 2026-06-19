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
async function postMessage(token: string, channel: string, blocks: unknown[], text: string,) : Promise<boolean>
```

### `lookupUserByEmail` — function

```ts
async function lookupUserByEmail(token: string, email: string) : Promise<string | null>
```

### Inbound helpers — Slack Roadmap Console

Added for the [[../integrations/slack-roadmap-console]] (the first inbound Slack surface).

```ts
function verifySlackSignature(rawBody: string, signature: string | null, timestamp: string | null) : boolean
async function resolveWorkspaceByTeamId(teamId: string) : Promise<string | null>
async function findChannelByName(token: string, name: string) : Promise<string | null>
async function openModal(token: string, triggerId: string, view: unknown) : Promise<boolean>
async function postEphemeral(token: string, channel: string, user: string, blocks: unknown[], text: string) : Promise<boolean>
async function updateMessage(token: string, channel: string, ts: string, blocks: unknown[], text: string) : Promise<boolean>
```

`verifySlackSignature` — HMAC-SHA256 over `v0:{ts}:{body}` keyed by `SLACK_SIGNING_SECRET`, rejecting > 5 min timestamp skew (replay guard). Pass the **raw** unparsed body.

### `listChannels` — function

```ts
async function listChannels(token: string) : Promise<
```

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
- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts` ([[../integrations/slack-roadmap-console]])
- `src/lib/slack-notify.ts` · `src/lib/slack-roadmap.ts` · `src/lib/slack-identity.ts` · `src/lib/inngest/slack-roadmap-notify.ts`

## Gotchas

- **Inbound signature verification needs the raw body.** Read `await request.text()` and verify **before** parsing — verifying a re-serialized body fails the HMAC.

## Related

[[../integrations/slack-roadmap-console]] · [[slack-roadmap]] · [[slack-identity]] · [[slack-notify]]

---

[[../README]] · [[../../CLAUDE]]
