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

### `deriveInternalRefundCeilingCents` — function

```ts
function deriveInternalRefundCeilingCents(input: { orderTotalCents: number; refundedCents: number }) : number
```

### `assertReturnRefundHeadroom` — function

```ts
function assertReturnRefundHeadroom(input: { netRefundCents: number; refundableCents: number | null; orderNumber: string }) : ReturnRefundHeadroomVerdict
```

### `readReturnCreationRefundLedger` — function

```ts
async function readReturnCreationRefundLedger(admin: AdminClient, workspaceId: string, orderId: string) : Promise<{ refundedCents: number; refundableCents: number | null; ok: boolean }>
```

### `ReturnRefundHeadroomVerdict` — type

```ts
type ReturnRefundHeadroomVerdict = { ok: true } | { ok: false; reason: "unreadable_ledger" | "exceeds_ceiling"; error: string }
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

## Live refund headroom (Phase 2 of [[../specs/remedy-state-must-see-out-of-band-refunds]] + Phase 2 of [[../specs/internal-order-returns-blocked-by-refund-headroom-guard]])

- **`readReturnCreationRefundLedger(admin, workspaceId, orderId)`** — one Shopify call returning `{ refundedCents, refundableCents, ok }` for the return-creation path. Routes through [[refund-ledger]] `getOrderRefundLedger` so out-of-band Shopify refunds (a manual refund in the Shopify admin, an Appstle-side refund) COUNT against the ceiling. On a ledger failure the mirror-only sum populates `refundedCents` but `refundableCents=null` — a caller that needs to REFUSE keys on `null`, never invents a zero. Same live-ledger source [[cx-agent-sdk]] `getOrderRemedyState` reads (Phase 1 of the same spec). **Phase 1 of [[../specs/internal-order-returns-blocked-by-refund-headroom-guard]]**: branches on `getOrderRefundLedger`'s discriminated `reason`; if `no_shopify_order_id`, computes a local ceiling via `deriveInternalRefundCeilingCents` and returns `ok:true`; any OTHER failure reason (`shopify_call_failed` / `order_not_found` / `invalid_input`) still returns `refundableCents=null` so a Shopify outage is not downgraded to a local guess.
- **`sumSucceededOrderRefundsCents(admin, workspaceId, orderId)`** — thin wrapper returning just `readReturnCreationRefundLedger(...).refundedCents`. Used by [[../inngest/return-pipeline|`returnsIssueRefund`]]'s refund-time re-check as one of the cascading caps (local mirror → local ledger → gateway `decideRefundReconcile`).
- **`deriveInternalRefundCeilingCents({orderTotalCents, refundedCents})`** — pure helper returning `max(0, orderTotalCents - refundedCents)`. Phase 1 of [[../specs/internal-order-returns-blocked-by-refund-headroom-guard]]: internal (SHOPCX*) orders have no separate Shipping Protection line — the total IS the customer-paid figure — so we net the mirror's terminal refunds directly against `orders.total_cents`. Unlike subtotal-based Shopify orders, this uses the full order total.
- **`assertReturnRefundHeadroom({netRefundCents, refundableCents, orderNumber})`** → `ReturnRefundHeadroomVerdict` — pure headroom check extracted from the inline block in `createFullReturn` so the check's position is expressed as one named call (anti-drift). **Phase 2 of [[../specs/internal-order-returns-blocked-by-refund-headroom-guard]]**: runs BEFORE the returns row is inserted and BEFORE the EasyPost label is purchased. Inputs are DB-only. Refuses with named numbers when the ledger is unreadable (`refundableCents=null`) OR when `netRefundCents > refundableCents`; `ok:false` carries a caller-facing `error` string; `ok:true` means the return is safe. A failed refusal creates NO returns row, so no open stub can block the one-return-per-ticket guard on a retry.
- **`ReturnRefundHeadroomVerdict`** — discriminated type: `{ ok: true }` | `{ ok: false, reason: "unreadable_ledger" | "exceeds_ceiling", error: string }`.
- **Creation-time refusal.** `createFullReturn` REFUSES to create a return when `net_refund_cents > refundableCents` (ledger readable) OR when the ledger is unreadable and the promised refund is > 0. Rationale: a return that promises more than the order can pay strands the customer — they ship product back and then chase us for money that will never settle. Derived-from ticket dac9f0c7 (yvette SC126000, 2026-08-24): a $55.86 promise against $5.32 of real headroom stranded the customer for 25 days. Derived-from ticket 6b0cd91c (Denise Richling, 2026-08-28, Phase 1 of internal-order spec): two orphaned $9.42 USPS labels + one blocking stub before the headroom check was hoisted before the label purchase.

## Refund math (Phase 3 of [[../specs/remedy-state-must-see-out-of-band-refunds]])

- **`net_refund_cents = order_subtotal - refunds_succeeded - label_cost`** (floored at 0), matching the [[../tables/policies|`returns` policy]] `returns.refund_formula` machine rule (`order_subtotal - label_cost`) and its exclusions (Shipping Protection, customer-paid shipping, return label costs). Before Phase 3 shipped, the computation used the order TOTAL and inflated every MBG return by the shipping + tax component — yvette SC126000 was promised $55.86 when the policy sanctioned $50.54.
- **`deriveOrderSubtotalCentsFromLines(lines)`** — one exported helper that sums `line_items[].price_cents × quantity − line_items[].total_discount_cents` EXCLUDING any Shipping Protection line (matched by title, same regex [[avalara-tax-codes]] `classifyByShopifyCategory` uses to tax-bucket the SP line). `public.orders` has NO subtotal column (probed 2026-08-24 — columns are `total_cents, line_items, shipping_protection_amount_cents, avalara_total_tax_cents`), so we derive from lines and pin the derivation in one place so every refund path agrees. **Phase 1 of [[../specs/return-net-refund-must-net-per-line-discounts]]** — `total_discount_cents` (mirrored from Shopify's `total_discount` webhook field by [[shopify-webhooks]]) is netted per line so the subtotal reflects what the customer actually paid, floored at 0 per line so a bad row cannot push the total negative. Before this fix the derivation summed gross `price × qty` and IGNORED per-line discounts, so any discounted order over-promised the refundable ceiling by the discount amount — derived-from ticket `d17c7b1c` (Kimberly SC137380): coffee $79.95 × 2 gross $159.90 with a $12.78 line discount (customer paid $147.12) on an order collected at $155.95 was refused by `assertReturnRefundHeadroom` even though the customer only ever paid within the ceiling. Regression pinned in `shopify-returns.deriveSubtotal.test.ts` (`npm run test:shopify-returns-derive-subtotal`).
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
