# libraries/slack-notify

`dispatchSlackNotification()` — routes per-event Slack messages per [[../tables/slack_notification_rules]].

**File:** `src/lib/slack-notify.ts`

## File header

```
Slack notification dispatcher — non-blocking, fire-and-forget
```

## Exports

### `dispatchSlackNotification` — function

```ts
async function dispatchSlackNotification(workspaceId: string, eventType: EventType, data: Record<string, unknown>,) : Promise<void>
```

## Callers

- `src/app/api/tickets/[id]/route.ts`
- `src/app/api/webhooks/email/route.ts`
- `src/lib/escalation.ts`
- `src/lib/inngest/chargeback-processing.ts`
- `src/lib/inngest/dunning.ts`
- `src/lib/inngest/fraud-detection.ts`
- `src/lib/inngest/journey-outcomes.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
