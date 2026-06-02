# libraries/easypost-email

Return label email send via Resend.

**File:** `src/lib/easypost-email.ts`

## File header

```
Return label email — sends label PDF link + tracking + refund breakdown to customer
```

## Exports

### `sendReturnLabelEmail` — function

```ts
async function sendReturnLabelEmail({ workspaceId, toEmail, customerName, orderNumber, trackingNumber, carrier, labelUrl, labelCostCents, orderTotalCents, netRefundCents, resolutionType, }: { workspaceId: string; toEmail: string; customerName: string | null; orderNumber: string; trackingNumber: string; carrier: string; labelUrl: string; labelCostCents: number; orderTotalCents: number; netRefundCents: number; resolutionType: string; }) : Promise<
```

## Callers

- `src/app/api/workspaces/[id]/returns/create-label/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
