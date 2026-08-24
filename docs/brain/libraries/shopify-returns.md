# libraries/shopify-returns

`createFullReturn()` (the single entry point for new returns), `closeReturn()`, `partialRefundByAmount()`, `issueStoreCredit()`. Stores `net_refund_cents` at creation; pipeline trusts it forever. See [[../lifecycles/return-pipeline]].

**File:** `src/lib/shopify-returns.ts`

## File header

```
Shopify Returns API — create returns, attach tracking, dispose items, process, close
```

## Exports

### `createShopifyReturn` — function

```ts
async function createShopifyReturn(workspaceId: string, params: CreateReturnParams,) : Promise<CreateReturnResult>
```

### `attachReturnTracking` — function

```ts
async function attachReturnTracking(workspaceId: string, params: AttachTrackingParams,) : Promise<
```

### `disposeReturnItems` — function

```ts
async function disposeReturnItems(workspaceId: string, params: DisposeParams,) : Promise<
```

### `processReturn` — function

```ts
async function processReturn(workspaceId: string, returnId: string,) : Promise<
```

### `closeReturn` — function

```ts
async function closeReturn(workspaceId: string, returnId: string,) : Promise<
```

### `getReturnableItems` — function

```ts
async function getReturnableItems(workspaceId: string, shopifyOrderGid: string,) : Promise<ReturnableItem[]>
```

### `createFullReturn` — function

```ts
async function createFullReturn(params: FullReturnParams) : Promise<FullReturnResult>
```

### `CreateReturnParams` — interface

### `CreateReturnResult` — interface

### `AttachTrackingParams` — interface

### `DisposeParams` — interface

### `ReturnableItem` — interface

### `FullReturnParams` — interface

### `FullReturnResult` — interface

### `RecoverableShopifyReturnError` — class

Thrown by `createShopifyReturn` when the Shopify-side mirror comes back null (no returnable lines / Shopify rejected the return) or with userErrors. `createFullReturn` catches this class and returns `{ success: false, error }` WITHOUT `console.error` so a healthy recovery doesn't churn the Control Tower error feed.

### `Disposition` — type

## Callers

- `src/app/api/workspaces/[id]/returns/[returnId]/dispose/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/refund/route.ts`
- `src/app/api/workspaces/[id]/returns/[returnId]/route.ts`
- `src/app/api/workspaces/[id]/returns/create-label/route.ts`
- `src/app/api/workspaces/[id]/returns/route.ts`
- `src/lib/inngest/returns.ts`

## Live refund headroom (Phase 2 of [[../specs/remedy-state-must-see-out-of-band-refunds]])

- **`readReturnCreationRefundLedger(admin, workspaceId, orderId)`** — one Shopify call returning `{ refundedCents, refundableCents, ok }` for the return-creation path. Routes through [[refund-ledger]] `getOrderRefundLedger` so out-of-band Shopify refunds (a manual refund in the Shopify admin, an Appstle-side refund) COUNT against the ceiling. On a ledger failure the mirror-only sum populates `refundedCents` but `refundableCents=null` — a caller that needs to REFUSE keys on `null`, never invents a zero. Same live-ledger source [[cx-agent-sdk]] `getOrderRemedyState` reads (Phase 1 of the same spec).
- **`sumSucceededOrderRefundsCents(admin, workspaceId, orderId)`** — thin wrapper returning just `readReturnCreationRefundLedger(...).refundedCents`. Used by [[../inngest/return-pipeline|`returnsIssueRefund`]]'s refund-time re-check as one of the cascading caps (local mirror → local ledger → gateway `decideRefundReconcile`).
- **Creation-time refusal.** `createFullReturn` REFUSES to create a return when `net_refund_cents > refundableCents` (ledger readable) OR when the ledger is unreadable and the promised refund is > 0. Rationale: a return that promises more than the order can pay strands the customer — they ship product back and then chase us for money that will never settle. Derived-from ticket dac9f0c7 (yvette SC126000, 2026-08-24): a $55.86 promise against $5.32 of real headroom stranded the customer for 25 days.

## Refund math (Phase 3 of [[../specs/remedy-state-must-see-out-of-band-refunds]])

- **`net_refund_cents = order_subtotal - refunds_succeeded - label_cost`** (floored at 0), matching the [[../tables/policies|`returns` policy]] `returns.refund_formula` machine rule (`order_subtotal - label_cost`) and its exclusions (Shipping Protection, customer-paid shipping, return label costs). Before Phase 3 shipped, the computation used the order TOTAL and inflated every MBG return by the shipping + tax component — yvette SC126000 was promised $55.86 when the policy sanctioned $50.54.
- **`deriveOrderSubtotalCentsFromLines(lines)`** — one exported helper that sums `line_items[].price_cents × quantity` EXCLUDING any Shipping Protection line (matched by title, same regex [[avalara-tax-codes]] `classifyByShopifyCategory` uses to tax-bucket the SP line). `public.orders` has NO subtotal column (probed 2026-08-24 — columns are `total_cents, line_items, shipping_protection_amount_cents, avalara_total_tax_cents`), so we derive from lines and pin the derivation in one place so every refund path agrees.
- **`computeReturnNetRefundCents`** takes `{ orderSubtotalCents, labelCostCents, refundsSucceededCents }`. The input was renamed from the historical total-based name so a caller cannot pass the wrong figure by habit. Pure — the ledger fetch + the subtotal derivation both live at the caller.
- The DB column `public.returns.order_total_cents` still holds the CUSTOMER-PAID total (`orders.total_cents`) for audit; the SUBTOTAL is only the input to the net-refund compute.

## Gotchas

- Always go through `createFullReturn()` — never set `is_return: true` on EasyPost shipments directly (it swaps from/to addresses).
- `net_refund_cents` is set at creation and is the contract. Never re-derive at refund time.
- `freeLabel: true` = we eat the EasyPost cost; net_refund = order_subtotal - refunds_succeeded (Phase 3 — subtotal, not total).
- `createShopifyReturn` throws `RecoverableShopifyReturnError` for caller-handled failures (null Shopify mirror, Shopify userErrors). `createFullReturn` catches that class and returns `{ success: false, error }` WITHOUT `console.error` so a healthy recovery doesn't churn the Control Tower error feed (signature `vercel:314ca8c785aff3eb`). Unexpected throws still log.
- `closeReturn` splits two cases: if the return row is missing (`!ret`), it returns `{ success: false }` (genuine failure); if the row exists but `shopify_return_gid` is null (internal-order path), it returns `{ success: true }` immediately without calling Shopify — documented no-op since `createFullReturn` never creates a Shopify RETURN for internal orders. The Inngest caller in `returns-issue-refund` tolerates both outcomes via console.error; this reduces log noise for the internal-path case.

---

[[../README]] · [[../../CLAUDE]]
