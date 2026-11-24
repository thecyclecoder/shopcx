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
async function sendSMS(
  workspaceId: string,
  to: string,
  body: string,
  options?: {
    mediaUrl?: string | null;
    statusCallback?: string | null;
    sendAt?: Date | null;
    messagingServiceSid?: string | null;
  }
): Promise<{ success: boolean; messageSid?: string; error?: string; errorCode?: number }>
```

Send SMS or MMS via Twilio. Body is truncated at 1600 chars (10 segments). Pass `mediaUrl` to send as MMS (URL must be publicly reachable). **Scheduled sends require a Messaging Service:** if `options.sendAt` is set and `options.messagingServiceSid` is null, returns `{ success: false, error: 'scheduled_send_requires_messaging_service' }` WITHOUT calling Twilio — never falls back to immediate send, enforcing the CEO's 9 AM-local legal rule. The only scheduled-send callers are [[../libraries/pre-renewal-reminders]] and [[../inngest/marketing-text]]; both always pass `messagingServiceSid`. Guard verified by `npm run test:twilio-scheduled-send-guard`.

### `validateTwilioSignature` — function

```ts
function validateTwilioSignature(signature: string, url: string, params: Record<string, string>) : boolean
```

### `getWorkspacePhone` — function

```ts
async function getWorkspacePhone(workspaceId: string): Promise<string | null>
```

## Callers

- `src/app/api/popup/claim/route.ts` — popup-coupon SMS send
- `src/app/api/tickets/[id]/messages/route.ts` — transactional ticket SMS
- `src/app/api/webhooks/sms/route.ts` — inbound SMS webhook
- `src/app/api/webhooks/twilio/marketing-sms/route.ts` — marketing SMS webhook
- `src/app/api/webhooks/twilio/marketing-status/route.ts` — marketing status callback
- `src/app/api/workspaces/[id]/sms/test/route.ts` — SMS send test endpoint
- `src/lib/inngest/marketing-text.ts` — scheduled campaign sends (passes `messagingServiceSid`)
- `src/lib/inngest/sms-callback-drain.ts` — STOP/START reply sends
- `src/lib/pre-renewal-reminders.ts` — scheduled reminder sends (passes `messagingServiceSid`)
- `src/lib/meta/budget-alerts.ts` — founder alerts
- `src/lib/commerce/founder-cancel-sms.ts` — founder cancel alerts
- `src/lib/cart-recovery.ts` — cart recovery SMS
- `src/lib/inngest/deliver-pending-send.ts` — pending SMS delivery
- `src/lib/inngest/investor-monthly-invite.ts` — investor invite SMS
- `src/lib/god-mode.ts` — god-mode founder SMS

## Gotchas

- **Scheduled sends MUST pass `messagingServiceSid`.** Twilio only honours `SendAt` (ScheduleType=fixed, 15 min–7 days out) for messages through a Messaging Service. Bare `From` number either fails or sends immediately. The guard enforces this for every caller — a scheduled send without a Messaging Service is always refused locally, never sent.
- **Messaging Service vs bare From number.** Pass `messagingServiceSid` for campaign/reminder sends (marketing pool). Otherwise use workspace `twilio_phone_number` (transactional pool). Separate sender pools prevent marketing throughput from congesting transactional.

---

[[../README]] · [[../../CLAUDE]]
