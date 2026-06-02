# libraries/loyalty

Loyalty program: tier eligibility, point earn / spend, redemption tier resolution, coupon code generation.

**File:** `src/lib/loyalty.ts`

## File header

```
Core loyalty logic — earning, spending, validation, calculations.
Native engine: no third-party provider. All points managed in our DB,
redemptions create Shopify discount codes.
```

## Exports

### `getLoyaltySettings` — function

```ts
async function getLoyaltySettings(workspaceId: string) : Promise<LoyaltySettings>
```

### `getMember` — function

```ts
async function getMember(workspaceId: string, shopifyCustomerId: string,) : Promise<LoyaltyMember | null>
```

### `getMemberByCustomerId` — function

```ts
async function getMemberByCustomerId(workspaceId: string, customerId: string,) : Promise<LoyaltyMember | null>
```

### `getOrCreateMember` — function

```ts
async function getOrCreateMember(workspaceId: string, shopifyCustomerId: string, email: string,) : Promise<LoyaltyMember>
```

### `getRedemptionTiers` — function

```ts
function getRedemptionTiers(settings: LoyaltySettings) : RedemptionTier[]
```

### `validateRedemption` — function

```ts
function validateRedemption(member: LoyaltyMember, tier: RedemptionTier,) :
```

### `pointsToDollarValue` — function

```ts
function pointsToDollarValue(points: number, settings: LoyaltySettings) : number
```

### `calculateEarningPoints` — function

```ts
function calculateEarningPoints(lineItemsTotal: number, deductions: OrderDeductions, settings: LoyaltySettings,) : number
```

### `earnPoints` — function

```ts
async function earnPoints(member: LoyaltyMember, points: number, orderId: string | null, description: string,) : Promise<void>
```

### `spendPoints` — function

```ts
async function spendPoints(member: LoyaltyMember, points: number, description: string, shopifyDiscountId: string | null,) : Promise<void>
```

### `deductPoints` — function

```ts
async function deductPoints(member: LoyaltyMember, points: number, orderId: string | null, type: "refund" | "chargeback", description: string,) : Promise<void>
```

### `LoyaltyMember` — interface

### `RedemptionTier` — interface

### `LoyaltySettings` — interface

### `OrderDeductions` — interface

## Callers

- `src/app/api/loyalty/balance/route.ts`
- `src/app/api/loyalty/members/[memberId]/route.ts`
- `src/app/api/loyalty/redeem/route.ts`
- `src/lib/portal/handlers/loyalty-apply-subscription.ts`
- `src/lib/portal/handlers/loyalty-balance.ts`
- `src/lib/portal/handlers/loyalty-redeem.ts`
- `src/lib/shopify-webhooks.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
