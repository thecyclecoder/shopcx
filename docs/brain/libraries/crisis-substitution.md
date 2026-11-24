# libraries/crisis-substitution

Flags order lines that Amplifier **likely shipped as a different flavor** during a crisis. While a
crisis is active, Amplifier ships the out-of-stock (affected) SKU as the crisis's alternative flavor,
but our `orders.line_items` still record the **ordered** variant — so the order row is NOT ground
truth for what the warehouse shipped.

**File:** `src/lib/crisis-substitution.ts` · test: `src/lib/crisis-substitution.test.ts`

## Why

Dylan 2026-11-24: June ruled Yukiko Ban's Hazelnut-for-Cocoa report false three times because the
order row said Cocoa (tickets e159a032, 3488aabf). The orders SDK and `remedy_state` show the ordered
variant, which is not what shipped during a crisis. Both Sol's and June's order context now flag the
likely-substituted line so a matching wrong-flavor report is believed, not denied.

## Exports

- `annotateCrisisSubstitution(lines, order, activeCrises)` → `Array<line & { likely_substituted,
  likely_shipped_flavor?, crisis_id? }>` (PURE). A line flags `likely_substituted=true` when (1) its
  `variant_id` equals (or its `sku` matches) a crisis's `affected_variant_id`/`affected_sku`; (2) the
  crisis covered the ship — status `active`, or `resolved` on/after the ship date; and (3)
  `order.amplifier_shipped_at` is on or after the crisis's `created_at`. The likely-shipped flavor is
  the crisis's `default_swap_title`. No Amplifier ship stamp ⇒ never flagged (warehouse hasn't shipped).
- `getSubstitutionCrises(admin, workspaceId)` → `SubstitutionCrisis[]` (SDK accessor). Active +
  recently-resolved [[../tables/crisis_events]] rows that have a `default_swap_variant_id` (only those
  substitute). `resolved_at` is derived from `updated_at` on a resolved row (the resolve action stamps
  `status='resolved'` + `updated_at` in one write). Read crises through here, never a raw
  `.from("crisis_events")` at the call site.

## Callers

- [[sonnet-orchestrator-v2]] `getCustomerAccount` — Sol's RECENT ORDERS block appends a
  `[LIKELY SHIPPED AS <flavor> — crisis substitution …]` note to each flagged line.
- [[cx-agent-sdk]] `getCxOrders` stamps `likely_substituted` / `likely_shipped_flavor` on each
  `CxOrderLine`; `formatCxOrders` renders the same note in June's ground-truth / `remedy_state` brief.

## Related

- [[crisis-restart-swap]] (the same affected-variant / default-swap matching, for restarts)
- [[../tables/crisis_events]] · [[../tables/crisis_customer_actions]]

---

[[../README]] · [[../../CLAUDE]]
