# libraries/commerce__loyalty

The **Display** half of the commerce SDK for loyalty — one balance read + one append-log walk, both cursor-paginated past PostgREST's 1000-row cap.

**File:** `src/lib/commerce/loyalty.ts` · **Spec:** [[../specs/commerce-sdk-display-operations]] Phase 3 · **Depends on:** [[../tables/loyalty_members]] · [[../tables/loyalty_transactions]] · [[loyalty]]

## Why this exists

Loyalty state is split across two tables: `loyalty_members` (per-customer enrollment + balance) and `loyalty_transactions` (the append-only earn/spend/adjust ledger). Every surface that renders points reads both — the SDK collapses them behind two entity-named ops.

Ships with zero call-site consumers — the M3 harness compares parity before any surface migrates.

## Exports

- **`getLoyaltyBalance(workspaceId, customerId)`** → `LoyaltyView` — the customer's balance + dollar value + redemption tiers they qualify for. Returns a zero-balance view when the customer is not enrolled (no `loyalty_members` row).
- **`listLoyaltyLedger(workspaceId, filters?)`** → `LoyaltyLedgerEntryView[]` — one customer's ledger walked past the 1000-row cap. Cursor on `(created_at DESC, id DESC)`. Filters: `member_id` or `customer_id` (the SDK looks up the member row from customer id), `type`, `page_size`, `max_rows`.

Type re-exports: `LoyaltyView`, `LoyaltyRedemptionTierView`, `LoyaltyLedgerEntryView`.

## Callers

None. The M3 harness ([[../specs/spec-goal-branch-pm-flow]] M3) compares SDK output vs the existing per-surface hydration paths before rollout — no consumer is retargeted yet.

---

[[../README]] · [[../../CLAUDE]] · [[commerce__customer]]
