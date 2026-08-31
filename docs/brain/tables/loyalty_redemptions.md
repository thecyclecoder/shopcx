# loyalty_redemptions

Points redemption events — coupon issued, used, expired.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `member_id` | `uuid` | — | → [[loyalty_members]].id |
| `reward_tier` | `text` | — |  |
| `points_spent` | `int4` | — |  |
| `discount_code` | `text` | — |  |
| `shopify_discount_id` | `text` | ✓ |  |
| `discount_value` | `numeric` | — |  |
| `status` | `text` | — | default: `'active'` |
| `used_at` | `timestamptz` | ✓ | Stamped by [[../libraries/loyalty]] `consumeRedemption` when the reward is genuinely delivered (order landed, subscription renewed, refund paid). Compare-and-set on `used_at IS NULL` so a double-call is a no-op — never sprinkle raw writes to this column. |
| `consumed_via` | `text` | ✓ | How the row was consumed at `used_at` time. Values: `order` · `subscription_renewal` · `refund`. Written on the same UPDATE as `used_at` by `consumeRedemption`; NULL while `used_at IS NULL`. |
| `expires_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `member_id` → [[loyalty_members]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("loyalty_redemptions")
  .select("id, status, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("loyalty_redemptions")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("loyalty_redemptions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **`status` column values:** `active` (ready to apply), `applied` (landed on subscription, waiting for next charge), `used` (consumed on an order), `expired` (past expiry date or superseded by a regen), `rolled_back` (re-credited after apply failed — Phase 1 of the atomic redeem→apply contract). No CHECK constraint; values are documented in [[../libraries/loyalty]]. The `expired` status is set atomically via `claimRegenSpendSlot` ([[../libraries/action-executor]]) when a regen is about to mint a successor code — this is the compare-and-set guard that gates idempotent `spendPoints` on `apply_loyalty_coupon` retry. **Apply-eligibility guard:** When materializing a LOYALTY-* code as an internal coupon via [[../libraries/coupons]] `ensureInternalLoyaltyCouponRow`, the `status`, `used_at`, and `expires_at` columns are checked by pure helper `isRedemptionStateApplyEligible` — a stale/consumed/expired redemption cannot be revived as a fresh single-use coupon on ANY customer's contract (coupon-replay defense per spec [[../specs/loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value]] Phase 3 Fix 2).
- **Never mutate `status` directly.** All status changes route through [[../libraries/loyalty]] helpers (`consumeRedemption` for the active/applied → used transition, `rollbackLoyaltyRedemptionOnApplyFailure` for rollback) or the atomic guard (`claimRegenSpendSlot` for regen). Raw updates bypass the idempotency/atomicity contracts and leave the ledger in drift.
- **`used_at` writers and their consumption kinds:**
  - `order` — [[../libraries/loyalty]] `consumeRedemption` called from the Shopify order-ingest webhook ([`src/lib/shopify-webhooks.ts`](../../src/lib/shopify-webhooks.ts) `handleOrderEvent`, inside `isNewOrder`). Fires per LOYALTY-* code in `payload.discount_codes`. Compare-and-set on `used_at IS NULL` so a webhook replay is idempotent. Covers subscription renewals — they flow through the same webhook.
  - `refund` — the loyalty cash-refund path in [[../libraries/action-executor]]. Two writers: (a) the `redeem_points_as_refund` handler stamps `consumed_via='refund'` inline on the born-used REFUND-* row it mints (status=`redeemed_as_refund`, `used_at=now`); (b) `reconcileLoyaltyRefundCoupons` stamps `consumed_via='refund'` on every active LOYALTY-* row it flips to `redeemed_as_refund` in the ticket window (SC135320 dangling-coupon reconciliation). Neither routes through `consumeRedemption` — its compare-and-set is scoped to `status IN ('active','applied') → 'used'`; the refund path uses `redeemed_as_refund` for the SC135320 semantic.
  - `subscription_renewal` — reserved for a future direct writer if renewal delivery ever needs a distinct code path. The `RedemptionConsumedVia` type declares it so callers can pass it through `consumeRedemption`; nothing writes it today (renewals ride the `order` path via the shared webhook).
- **The rest of the codebase only READS `used_at`** — the ticket orchestrator's unused-rewards list ([[../libraries/sonnet-orchestrator-v2]]), the `/api/loyalty/redemptions` projection, and the loyalty dashboard's display column. Any NEW consumption point MUST either call `consumeRedemption` (transitioning an existing `active`/`applied` row) or stamp `consumed_via` inline on a mint-and-use insert; never issue a raw `.update({used_at})` — that bypasses the chokepoint and the SC135320 status contract.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
