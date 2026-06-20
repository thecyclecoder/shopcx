# Migration: Shipping Protection (line item → internal flag) ⏳

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" ([[../lifecycles/subscription-billing.md]] § Migration path). The `code_gap` class behind a stuck migration (sub `4b831caa`) the [[migration-fix-agent]] couldn't repair.

**The bug.** On Appstle, **shipping protection is a line item** (a "Shipping Protection" line, e.g. $3.75). On an internal sub it's a **flag**: `subscriptions.shipping_protection_added=true` + `shipping_protection_amount_cents`, and the pricing engine bills it **separately** (not from `items[]`). But `appstleLinesToInternalItems` (`src/lib/migrate-to-internal.ts`) converts **every** Appstle line into a regular `items[]` entry — it never recognizes the protection line — so after migration:
- the protection line sits in `items[]` as a bogus product line (no catalog variant), and the flag is never set; and
- `pre_migration_charge_cents` (the audit baseline, summed over all Appstle lines at migrate time) **over-counts by the protection amount**, because the engine's `product_subtotal_cents` (what `pricing_preserved` compares against) excludes protection.

→ `pricing_preserved` fails on every protection-carrying migration, and **none of the mechanical fixes (`price_reconcile`/`variant_backfill`/`appstle_cancel`) can wire the protection columns**, so the migration-fix agent is stuck too.

Two fixes, per the enumerated ask:

## 1) Fix how migration moves shipping protection (`migrate-to-internal.ts`)
In `appstleLinesToInternalItems` (and the `pre_migration_charge_cents` capture), **detect the Appstle "Shipping Protection" line** (by line title — the Appstle protection line is titled "Shipping Protection"; confirm against the live contract) and, instead of pushing it to `items[]`:
- set `shipping_protection_added = true` + `shipping_protection_amount_cents = <the protection line's price_cents>` on the flipped sub;
- **exclude** the protection line from `items[]` (it's a flag now, never a catalog item);
- **exclude** it from `pre_migration_charge_cents` so the baseline is the **product subtotal only** (the engine re-adds protection on top via the flag, reproducing the old total). The audit's `pricing_preserved` then compares product-subtotal ≈ product-subtotal and passes, while the customer's charged total is unchanged.

## 2) Let the migration-fix agent do this fix (new `fix_kind`)
Add **`shipping_protection_convert`** to `MigrationFixKind` + `applyMigrationFix` (`src/lib/migration-fix.ts`), the deterministic gated executor. Payload `{ amount_cents, baseline_cents }`. It, idempotently:
- sets `shipping_protection_added=true` + `shipping_protection_amount_cents = amount_cents`;
- removes the "Shipping Protection" line from the sub's `items[]` (leaves real product lines + their overrides **untouched** — do NOT raise any product override);
- corrects the audit row's `pre_migration_charge_cents` to `baseline_cents` (the product-only subtotal the protection line had inflated);
- then the worker re-runs `verifyMigration` → a re-`passed` clears the row.

The `migration-fix` skill learns to **propose `shipping_protection_convert`** for a `pricing_preserved` failure whose overage equals an Appstle protection line (read the live contract): "old charge over-counted by the $X protection line the engine bills separately → wire the flag + correct the baseline, don't raise the product override."

## First use + verification (sub `4b831caa`)
- Apply to `4b831caa`: set `shipping_protection_added=true`, `shipping_protection_amount_cents=375`, remove the Shipping Protection line from `items[]`, **leave Tabs at $59.96 (do NOT raise its override)**, and correct `pre_migration_charge_cents` 6371¢ → **5996¢**. Re-verify → `pricing_preserved` passes → the row clears from `/dashboard/migrations`. The customer still renews at the same total (5996 + 375 = 6371).
- A future Appstle→internal migration of a protection-carrying contract → lands with `shipping_protection_added=true` + the flag amount, **no** protection line in `items[]`, baseline = product-only, and audit `passed` on the first pass (no migration-fix needed).
- Negative: product line prices/overrides are never altered by either fix; a sub with no protection line is unaffected.

## Phase 1 — migration converts protection + audit baseline ⏳
The `appstleLinesToInternalItems` + `pre_migration_charge_cents` change in `src/lib/migrate-to-internal.ts`. Brain: [[../libraries/migrate-to-internal]] + [[../libraries/migration-audit]] + [[../lifecycles/subscription-billing.md]].

## Phase 2 — `shipping_protection_convert` fix_kind + skill + fix 4b831caa ⏳
`MigrationFixKind` + `applyMigrationFix` case + the `migration-fix` skill proposal rule + apply to `4b831caa`. Brain: [[../libraries/migration-fix]] + [[migration-fix-agent]] + [[../dashboard/migrations]].
