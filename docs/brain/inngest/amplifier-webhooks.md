# inngest/amplifier-webhooks

Receives Amplifier (3PL) `order_received` / `order_shipped` webhooks → updates `orders.amplifier_*` fields.

**File:** `src/lib/inngest/amplifier-webhooks.ts`

## Functions

### `amplifier-webhook-process`
- **Trigger:** event `amplifier/webhook-received`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspaceId" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/orders]]

## Tables read (not written)



## Header notes

```
Async Amplifier webhook processing via Inngest
Webhook route validates token + fires event → this function processes with concurrency control
```

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
