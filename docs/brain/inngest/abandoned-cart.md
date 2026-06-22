# inngest/abandoned-cart

Sweeps `cart_drafts` past `expires_at` → flips to `abandoned`. Hourly.

**File:** `src/lib/inngest/abandoned-cart.ts`

## Functions

### `abandoned-cart-reminder`
- **Trigger:** cron `*/10 * * * *` + event `storefront/abandoned-cart.tick`
- **Concurrency:** `concurrency: [{ limit: 1 }]`
- **Two touches per cart:** first touch when a cart is `open` with an email and idle 30+ min (stamps `abandoned_email_sent_at`); second touch 24 h later (stamps `abandoned_followup_sent_at`). Both go through `sendCartRecovery` (SMS-preferred, rich-email fallback).
- **Re-entry cooldown:** a customer (by email OR `customer_id`, per workspace) who got a first touch in the last **3 days** is NOT put back into the flow for a *different* cart — they still finish both touches of the cart they already entered. Computed from recent `abandoned_email_sent_at` across the customer's carts; no extra column.

**Control Tower heartbeat fires on every tick, including idle ones.** The `if (due.length === 0)` early-return emits its own `emitCronHeartbeat("abandoned-cart-reminder", { produced: { sent: 0, scanned: 0 } })` before returning, so a healthy-but-idle cron reads green instead of tripping monitor `cron_freshness` RED during off-peak windows with no due carts. The beat means "Inngest invoked me", not "there was work" — same empty-path fix as [[deliver-pending-send]] + [[ticket-csat]] ([[../specs/abandoned-cart-heartbeat-on-empty-run]]).


## Downstream events sent

_None._

## Tables written

- [[../tables/cart_drafts]]

## Tables read (not written)

- [[../tables/customers]]
- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
