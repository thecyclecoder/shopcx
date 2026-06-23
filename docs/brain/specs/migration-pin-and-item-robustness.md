# Migration robustness — pin the card + handle unmappable items ⏳

**Owner:** [[../functions/platform]] · **Parent:** hardens [[../lifecycles/migrate-to-internal]] / [[../lifecycles/subscription-billing]].

**Found in use 2026-06-23** (two real migrated subs): (1) `migrate-to-internal` **does not pin** the customer's card to the migrated sub — it leaves `subscriptions.payment_method_id = null` and relies on the renewal's *default-card fallback* ([[../lifecycles/subscription-billing]] § payment method). The fallback works, but it's implicit — the portal shows no pinned card, and a later default change silently moves the charge. The **recovery** flow already pins (`payment-method-update.ts:99-134`); migration should too. (2) A migrated sub can carry an **item the migration couldn't map** to an internal variant (Therese's out-of-stock ACV Gummies — a dangling Shopify `variant_id`, $0, no internal product) → the `items_on_uuids` audit check fails **forever** and the retry loop never clears (had to be fixed by hand).

## Phase 1 — pin the default card on migration ⏳
In [[../libraries/migrate-to-internal]], when the migrated internal sub is created, **set `payment_method_id` to the customer's default `customer_payment_methods` row** (if one exists with a `braintree_payment_method_token`) — be literal, mirroring the recovery flow's pin (`payment-method-update.ts`). The default-fallback stays as the safety net for subs with no pinned card. Idempotent (re-running migration re-pins the current default). Brain: [[../lifecycles/migrate-to-internal]] · [[../lifecycles/subscription-billing]] · [[../tables/subscriptions]].

### Verification — Phase 1
- Migrate a sub for a customer who has a default card → the new internal `subscriptions.payment_method_id` = that card's id (not null); the portal sub-detail shows the pinned card; the renewal charges it explicitly (not via fallback).
- A customer with **no** card → `payment_method_id` stays null, renewal still uses the default-fallback (unchanged, no regression).

## Phase 2 — handle unmappable items during migration ⏳
When migrating items, an item with **no resolvable internal variant** (no internal `product_variants` match for its Shopify `variant_id`) must not be left as a dangling Shopify-id line that fails `items_on_uuids` forever. Resolve it: **map it to the internal variant if one exists** (by `shopify_variant_id` / sku); if genuinely **unmappable** (out of stock / discontinued / no internal product), **drop the line with a logged `migration_audits` note** (and, for a *paid* item being dropped, flag for human review rather than silently shipping a short order). A $0 free-gift line that can't be mapped is safe to drop; a paid line that can't be mapped escalates. Brain: [[../libraries/migrate-to-internal]] · [[migration-audit|../libraries/migration-audit]].

### Verification — Phase 2
- Migrate a sub whose item maps to an internal variant by `shopify_variant_id` → the migrated line carries the internal UUID + sku (not the raw Shopify id); `items_on_uuids` passes.
- Migrate a sub with a **$0 unmappable** item (no internal product) → the line is dropped, a `migration_audits` note records it, `items_on_uuids` passes, the retry loop clears (no infinite fail — Therese's exact case).
- Migrate a sub with a **paid** unmappable item → it's flagged for human review (not silently dropped).
