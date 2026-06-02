# libraries/twilio

SMS send + webhook signature verifier. See [[../integrations/twilio]].

**File:** `src/lib/twilio.ts`

## Exports

### `getWorkspacePhone` — function

```ts
async function getWorkspacePhone(workspaceId: string) : Promise<string | null>
```

### `sendSMS` — function

```ts
async function sendSMS(workspaceId: string, to: string, body: string, options?: { mediaUrl?: string | null; statusCallback?: string | null; sendAt?: Date | null; messagingServiceSid?: string | null; },) : Promise<
```

### `validateTwilioSignature` — function

```ts
function validateTwilioSignature(signature: string, url: string, params: Record<string, string>) : boolean
```

## Callers

- `src/app/api/tickets/[id]/messages/route.ts`
- `src/app/api/webhooks/sms/route.ts`
- `src/app/api/webhooks/twilio/marketing-sms/route.ts`
- `src/app/api/webhooks/twilio/marketing-status/route.ts`
- `src/app/api/workspaces/[id]/sms/test/route.ts`
- `src/lib/inngest/marketing-text.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
