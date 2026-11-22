# libraries/crisis-restart-swap

Keeps a RESTARTED subscription off an out-of-stock flavor. When a customer restarts a sub (from the
portal or the win-back journey) that carries a line under an **active** [[../tables/crisis_events]]
row, the line is swapped to the crisis default and the customer is switched back on Resolve.

**File:** `src/lib/crisis-restart-swap.ts` · test: `npm run test:crisis-restart-swap`

## Why

CEO 2026-11-22: 241 of the 657 Wave 1 win-back recipients would have restarted a sub carrying
Strawberry Lemonade tabs or Cocoa instant coffee, both under active crises. A restart brought the
sub back exactly as it was, and neither the restart nor the renewal engine checks stock. The crisis
Auto-Swap only runs when an admin presses the button, so restarts after the last press billed the
missing flavor.

## Exports

- `crisisSwapsForItems(admin, workspaceId, items)` → `CrisisSwapPlan[]` (read-only). Active crises
  with a `default_swap_variant_id` whose affected line is on the sub (matched by Shopify variant id,
  resolved UUID, or SKU — the same rule as the Auto-Swap route).
- `crisisNotice(plans)` → the restart-page sentence ("X is out of stock right now, so we'll send Y
  instead and switch you back as soon as it's restocked (expected Jan 15)."), or null. A restock date
  that has passed is never shown.
- `applyCrisisSwapsAfterRestart(workspaceId, contractId)` → `CrisisSwapResult[]`. Called by
  [[subscription-reactivate]] `reactivateSubscription` after every successful restart, so the portal
  and the journey stay in sync. Swaps via `subSwapVariant` (carries the locked price; a $0 line is
  re-applied) and writes/updates the [[../tables/crisis_customer_actions]] row with `original_item`,
  `tier1_swapped_to`, `tier1_sent_at=now`, `current_tier=1`, `tier1_response='accepted_on_restart'`,
  `auto_swap_back=true`. The tier1 stamp stops the daily crisis cron from sending a second
  out-of-stock email. Never throws; never fails the restart.
- `crisisSwapNote(results)` → the internal ticket / portal note line (flags a failed swap for a
  by-hand fix).
- `findCrisisLine`, `futureRestock` — pure helpers.

## Swap back

`POST /api/workspaces/[id]/crisis/[crisisId]` `action=resolve` swaps every `auto_swap_back=true` row
back to `original_item` (compare-and-set: only while the sub still carries the swap variant and not
already the original; clears the flag on success; failures block the resolve unless
`force_resolve`). Rows enrolled by the Auto-Swap button are NOT swapped back automatically.

## Callers

[[subscription-reactivate]] (commerce SDK `reactivateSubscription`) → [[winback-reactivate-choice]],
[[portal__handlers__reactivate]], [[../inngest/journey-outcomes]]. [[reactivate-journey-builder]]
renders the notice.

## Limits

Only flavors under an active crisis are caught; `product_variants` carries no stock signal. An
out-of-stock product with no crisis row (e.g. Cocoa pods/K-cups on 11/22) still restarts as-is.

[[../lifecycles/crisis-campaign]] · [[../README]]
