# libraries/research/recipes/verify-subscription-changes

Recipe: did promised sub changes happen?

**File:** `src/lib/research/recipes/verify-subscription-changes.ts`

## File header

```
verify_subscription_changes — the big one. Parses the most recent
AI/agent outbound messages on a ticket for any claim that touched a
subscription, and verifies the live state matches.
Covers these claim types:
pause, resume, skip_next_order, change_next_date, change_frequency,
swap_variant, remove_item, add_item, update_line_price, cancel.
Each claim → one finding (state matches) or one gap (mismatch). Gaps
propose the exact direct_action params that should have run, so heal
is a one-call replay of what the AI said it did.
Cancel claims always emit a high-severity gap with NO proposed_heal —
executing a cancellation is destructive/high-impact, so it requires human
review. A cancel itself is NOT terminal — it's reactivatable via
`subscriptionAction(..,"resume")` (`status=ACTIVE` un-cancels the contract).
Heal proposals are limited to ones where we can resolve the target
variant_id (for swap/remove) and contract_id (explicit, single-sub
inference, or item-title match against current state).
```

## Exports

### `verifySubscriptionChanges` — const

```ts
const verifySubscriptionChanges: ResearchRecipe
```

## Callers

- `src/lib/research/index.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
