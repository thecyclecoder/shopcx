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
- `src/lib/slack-notify.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
