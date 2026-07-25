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

- **`status` column values:** `active` (ready to apply), `applied` (landed on subscription, waiting for next charge), `used` (consumed on an order), `expired` (past expiry date or superseded by a regen), `rolled_back` (re-credited after apply failed — Phase 1 of the atomic redeem→apply contract). No CHECK constraint; values are documented in [[../libraries/loyalty]]. The `expired` status is set atomically via `claimRegenSpendSlot` ([[../libraries/action-executor]]) when a regen is about to mint a successor code — this is the compare-and-set guard that gates idempotent `spendPoints` on `apply_loyalty_coupon` retry.
- **Never mutate `status` directly.** All status changes route through [[../libraries/loyalty]] helpers (`consumeRedemption` for the active/applied → used transition, `rollbackLoyaltyRedemptionOnApplyFailure` for rollback) or the atomic guard (`claimRegenSpendSlot` for regen). Raw updates bypass the idempotency/atomicity contracts and leave the ledger in drift.
- **`used_at` has exactly one writer:** [[../libraries/loyalty]] `consumeRedemption`. The rest of the codebase only READS it — the ticket orchestrator's unused-rewards list ([[../libraries/sonnet-orchestrator-v2]]), the `/api/loyalty/redemptions` projection, and the loyalty dashboard's display column. Any new consumption point (order webhook, refund handler, renewal path) MUST call `consumeRedemption` rather than issuing its own `.update({used_at})` — that's the whole point of the chokepoint.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
