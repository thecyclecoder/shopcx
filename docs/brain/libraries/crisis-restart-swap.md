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

- `crisisSwapsForItems(admin, workspaceId, items, subscriptionId?)` → `CrisisSwapPlan[]` (read-only).
  Active crises with a `default_swap_variant_id` whose affected line is on the sub (matched by Shopify
  variant id, resolved UUID, or SKU — the same rule as the Auto-Swap route). Each plan carries an
  `action: 'swap' | 'hold'`. When `subscriptionId` is passed, the existing
  [[../tables/crisis_customer_actions]] row for `(crisis, subscription)` is consulted: a customer who
  chose to wait (`customerIsWaitingForRestock`) gets a `hold` plan instead of a `swap`.
- `customerIsWaitingForRestock(row)` → true when the customer declined the substitute and is waiting:
  `hold_for_restock === true` (Phase 1 flag), `tier1_response === 'rejected'`, `tier2_response ===
  'rejected'`, or `tier3_response` in `('accepted_pause','accepted_remove')`. Such a customer must
  never be auto-swapped + charged on restart.
- `crisisNotice(plans)` → the restart-page sentence. For a `swap`: "X is out of stock right now, so
  we'll send Y instead and switch you back as soon as it's restocked (expected Jan 15)." For a
  `hold`: "X is out of stock right now. As you asked, we'll hold your subscription and ship X as soon
  as it's back (expected Jan 15). You won't be charged until then." null when nothing is out of stock;
  a restock date that has passed is never shown.
- `applyCrisisSwapsAfterRestart(workspaceId, contractId)` → `CrisisSwapResult[]`. Called by
  [[subscription-reactivate]] `reactivateSubscription` after every successful restart, so the portal
  and the journey stay in sync. Passes the resolved `sub.id` to `crisisSwapsForItems` so the hold
  decision is made per row.
  - **swap** plan: swaps via `subSwapVariant` (carries the locked price; a $0 line is re-applied). On
    a pre-existing [[../tables/crisis_customer_actions]] row it updates ONLY `tier1_swapped_to`,
    `auto_swap_back`, `updated_at` (never resets the tier responses / `original_item` / `hold_for_restock`
    that recorded the customer's earlier choices); a brand-new row is inserted with `original_item`,
    `tier1_sent_at=now`, `current_tier=1`, `tier1_response='accepted_on_restart'`, `auto_swap_back=true`.
  - **hold** plan: does NOT swap. Pauses the sub once via `subscriptionAction(..., 'pause', ...)` with
    no auto-resume date, and stamps the existing row `paused_at=now`, `auto_resume=true` (leaving tier
    responses / `original_item` / `hold_for_restock` intact), so the crisis Resolve rail — which already
    resumes `paused_at + auto_resume` rows — brings the sub back with the original flavor. If the sub has
    other in-stock lines the whole sub is still held (a partial ship is a later decision).

  The tier1 stamp stops the daily crisis cron from sending a second out-of-stock email. Never throws;
  never fails the restart.
- `crisisSwapNote(results)` → the internal ticket / portal note line. For a hold: "Held for restock
  (customer chose to wait): X; resumes automatically when the crisis is resolved." For a swap, the
  swap line (flags a failed swap for a by-hand fix).
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
