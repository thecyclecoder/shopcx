# libraries/integrations/amplifier

Amplifier (3PL) webhook handler — `order_received` / `order_shipped` events.

**File:** `src/lib/integrations/amplifier.ts`

## File header

```
Amplifier 3PL — order creation helper.
Reference: amplifier-api.md (POST /orders).
- Base URL:    https://api.amplifier.com
- Auth:        HTTP Basic with the workspace's amplifier API key as
username, blank password. We use the auth_token query
param form to keep header surface small.
- Order body:  order_source_code (workspace-configured), order_id (our
order_number), order_date, billing_info, shipping_info,
shipping_method, line_items.
Address policy from the user spec: Amplifier requires BOTH billing
and shipping. If we only have one we mirror to the other.
Return shape: `{ id }` on success — that's the Amplifier order
UUID, which we store on `orders.amplifier_order_id` so the
existing order.received webhook flow stays consistent.
```

## Exports

### `createAmplifierOrder` — function

```ts
async function createAmplifierOrder(input: CreateAmplifierOrderInput) : Promise<CreateAmplifierOrderResult>
```

### `CreateAmplifierOrderInput` — interface

### `CreateAmplifierOrderResult` — interface

## Callers

- `src/app/api/checkout/route.ts`
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts`
- `src/lib/inngest/internal-subscription-renewals.ts`

## Packing-slip founder note (`packing_slip_message`)

`CreateAmplifierOrderInput.packingSlipMessage` becomes the `packing_slip_message`
field on the Amplifier order body — the handwritten-style "founder note" printed
on the packing slip. It is built by [[packing-slip-message]]
(`src/lib/buildPackingSlipMessage`): a warm-welcome template for first-timers, an
order-count thank-you (optionally Haiku-paraphrased) for repeats.

**225-char limit.** Amplifier silently truncates this field somewhere around
**225–250 chars**, cutting the note off mid-sentence on the printed slip. So the
note is capped at **225** in two places:
- `buildPackingSlipMessage` — `MAX_CHARS = 225`, a graceful word-boundary cap
  (`capToLimit`), and the Haiku paraphrase is *rejected* (falls back to the
  short template) if the rewrite exceeds 225 post-ASCII-strip.
- `amplifier.ts` — `stripUnicode(...).slice(0, 225)` as a backstop for any
  caller that doesn't go through the builder.

Amplifier also rejects non-ASCII — both layers strip Unicode (emoji, em-dashes,
curly quotes, accents) before sending.

## Gotchas

- **`packing_slip_message` is silently truncated past ~225 chars** — keep the
  note ≤ 225 (enforced in the builder + the integration). See above.
- **Non-ASCII is rejected at validation** — `stripUnicode` on line descriptions
  and the packing-slip note keeps a stray emoji from tanking the whole order.

---

[[../README]] · [[../../CLAUDE]]
