# libraries/email-tracking

Self-hosted open pixel + click redirect tracking. Writes [[../tables/email_events]]. Pixel URL `/api/email/open?e={id}` + redirect `/api/email/click?e={id}&u={url}`.

**File:** `src/lib/email-tracking.ts`

## File header

```
Universal email event tracking — logs every outbound email and
processes Resend webhook events (delivered, opened, clicked, bounced).
Works for all email types: ticket replies, crisis, CSAT, dunning, marketing.
```

## Exports

### `injectTrackingPixel` — function

```ts
function injectTrackingPixel(html: string) :
```

### `mapTrackingToken` — function

```ts
async function mapTrackingToken(trackingToken: string, resendEmailId: string, workspaceId: string, recipientEmail: string, subject: string, ticketId?: string | null, customerId?: string | null,) : Promise<void>
```

### `injectTrackingLinks` — function

```ts
function injectTrackingLinks(html: string, trackingToken: string) : string
```

### `injectFullTracking` — function

```ts
function injectFullTracking(html: string) :
```

### `logEmailSent` — function

```ts
async function logEmailSent(params: { workspaceId: string; resendEmailId: string; recipientEmail: string; subject: string; ticketId?: string | null; customerId?: string | null; }) : Promise<void>
```

### `processResendEvent` — function

```ts
async function processResendEvent(params: { workspaceId: string; resendEmailId: string; eventType: string; occurredAt: string; recipientEmail?: string; subject?: string; metadata?: Record<string, unknown>; }) : Promise<void>
```

## Callers

- `src/app/api/track/click/[trackingId]/route.ts`
- `src/app/api/track/open/[emailId]/route.ts`
- `src/app/api/webhooks/resend-events/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
