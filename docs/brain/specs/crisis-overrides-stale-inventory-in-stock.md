# Active OOS crisis overrides stale inventory_quantity in orchestrator stock checks ✅

**Owner:** [[../functions/cs]] · **Parent:** CS mandate "Ticket-derived product fixes" · **Derived-from-ticket:** `9a7f9481-7c74-43e5-8d4a-c0788315d55b`

Make an active OOS crisis the authoritative signal for a variant's stock status in the orchestrator's inventory-facing tools. In src/lib/sonnet-orchestrator-v2.ts, both checkInventory (~L1089) and getProductKnowledge (~L992) compute availability solely from product_variants.inventory_quantity/available; the crisis_events table (status='active', expected_restock_date) is only used by restockFor() to annotate items ALREADY judged OOS. Change the isInStock/availability computation so that when an active crisis_event matches a variant by affected_variant_id or affected_sku (fallback: product title), the variant is reported OUT OF STOCK regardless of a stale positive inventory_quantity, and the expected_restock_date is surfaced inline. Have getProductKnowledge also fetch active crises (it currently doesn't) and apply the same override to its 'available' flavor list. Net effect: the orchestrator can no longer claim a crised SKU is back in stock or promise its reship.

## Problem (from ticket `9a7f9481-7c74-43e5-8d4a-c0788315d55b`)
Ticket 9a7f9481: Katie ordered Mixed Berry, received the Strawberry Lemonade auto-swap during the active Mixed Berry OOS crisis (restock 2026-07-09). check_inventory reported Mixed Berry 'in stock (qty 3746)' off a stale product_variants.inventory_quantity, so the Opus orchestrator told her it was back in stock, created a $0 replacement order (SC133260) for a zero-inventory SKU, and promised delivery 'in the next couple of days' — all false. inventory_quantity can lag Shopify, but the active crisis_events row is the reliable truth and was ignored for the in-stock decision.

## Phases
- ✅ **P1 — implement the fix** — `checkInventory` and `getProductKnowledge` in `src/lib/sonnet-orchestrator-v2.ts` now treat an active `crisis_events` row as authoritative over `inventory_quantity` (match: Shopify variant id → SKU → product title), forcing OUT OF STOCK with the restock date inline. `getProductKnowledge` now also fetches active crises (it previously didn't). Brain pages updated ([[../orchestrator-tools]], [[../libraries/sonnet-orchestrator-v2]]). Gated on `npx tsc --noEmit`. No schema change.

## Verification
- In `src/lib/sonnet-orchestrator-v2.ts`, `checkInventory` and `getProductKnowledge` both select `crisis_events` (status `active`) and match a variant by `affected_variant_id` (vs `product_variants.shopify_variant_id`) → `affected_sku` → `affected_product_title` → expect a matched variant reported OUT OF STOCK even when `inventory_quantity > 0`.
- Reproduce ticket `9a7f9481`: with the active Mixed Berry OOS crisis (restock 2026-07-09) and the stale `inventory_quantity` (3746) on that variant, call the `check_inventory` tool with query "Mixed Berry" → expect `Mixed Berry — …: OUT OF STOCK (qty 3746) — active OOS crisis (inventory count is not authoritative) (expected restock: 2026-07-09)`, not "in stock".
- Call the `get_product_knowledge` tool for the Mixed Berry product → expect Mixed Berry in the `OUT OF STOCK:` line with `(active OOS crisis — expected restock 2026-07-09)`, and absent from the `available:` line.
- Resolve/clear the crisis (status ≠ `active`) and re-run both tools → expect the variant reported in stock again (override is scoped to active crises only).
- Drive a full orchestrator turn for a customer asking whether crised Mixed Berry is back → expect the AI to state it's out of stock until ~Jul 9 and NOT create a $0 replacement order or promise an imminent reship.

> Authored by the box Improve agent from ticket `9a7f9481-7c74-43e5-8d4a-c0788315d55b`. Commission the build from the Roadmap board (owner = cs).
