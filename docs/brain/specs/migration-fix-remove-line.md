# Migration-Fix: Remove a Line Item (`remove_line` fix_kind) ✅

**Owner:** [[../functions/retention]] · **Parent:** extends [[migration-fix-agent]] + [[migration-shipping-protection]]. The `code_gap` behind stuck sub `e4589de9` (audit `4b831caa`) — a **free promo line** carried into the internal sub that the agent can't delete.

The migration-fix agent has `price_reconcile`, `variant_backfill`, `appstle_cancel`, and (from [[migration-shipping-protection]]) `shipping_protection_convert` — but **no way to remove a line from `items[]`**. So a migration that drags a **free / promo line** across (e.g. a $0 "ACV Gummies" add-on with no catalog variant) fails `items_on_uuids` and **can't be repaired**: `variant_backfill` is wrong (we don't want to *keep* the line, we want it *gone*), and nothing else deletes a line.

## Fix — `remove_line`
Add **`remove_line`** to `MigrationFixKind` + an `applyMigrationFix` case (`src/lib/migration-fix.ts`, the deterministic gated executor). Payload identifies the line to delete (`{ line_id }` or `{ shopify_variant_id }` / `{ title }` match — match the same way the audit identifies the offending line). It idempotently:
- removes the matching line from the sub's `items[]` (no-op if already gone);
- leaves every other line + its `price_override_cents` **untouched**;
- the worker then re-runs `verifyMigration` → a re-`passed` clears the row.

The `migration-fix` skill learns to **propose `remove_line`** when a failing line is a **free / promo add-on that shouldn't carry over** — i.e. an `items_on_uuids` line with **no catalog variant** that is **$0 / a promo** (not a real product missing a row). Decision rule: real product missing a `product_variants` row → `variant_backfill` (keep + remap); a free/promo line with no catalog identity → `remove_line` (delete). When unsure which, ask via `needs_input`.

## First use — e4589de9 (audit 4b831caa), composed with protection
This sub needs **two** fixes to clear, both now available:
- **`remove_line`** — delete the **free ACV Gummies** line from `items[]` (the `items_on_uuids` failure; a $0 promo line with no catalog variant).
- **`shipping_protection_convert`** ([[migration-shipping-protection]]) — turn on its **$3.95** protection (`shipping_protection_added=true`, `shipping_protection_amount_cents=395`) + correct the audit baseline so `pre_migration_charge_cents` is the **product subtotal only** ($59.96 Tabs). Leave Tabs at $59.96 (do NOT raise its override).
- Result: renews at **$63.91** (Tabs $59.96 + protection $3.95), `items_on_uuids` + `pricing_preserved` both clear, row passes.
- **Check-bug note (already addressed):** `pricing_preserved` "won't clear on its own because it doesn't count the $3.95 protection in the product subtotal" — correct: protection is billed via the flag, not `items[]`, so the **baseline** (`pre_migration_charge_cents`) must exclude it. That baseline correction ships in [[migration-shipping-protection]]; this spec only adds the line-removal capability.

## Verification
- A failed migration whose only `items_on_uuids` offender is a $0 promo line → the agent proposes `remove_line`; on approval the line is dropped + `verifyMigration` re-passes.
- e4589de9: `remove_line` (ACV Gummies) + `shipping_protection_convert` ($3.95) → both checks clear, renews $63.91, Tabs override unchanged.
- Negative: `remove_line` never touches another line's price/override; a real product line (with a catalog variant) is never proposed for removal — that's `variant_backfill` territory.

## Phase 1 — `remove_line` fix_kind + skill rule + fix e4589de9 ✅
- ✅ `MigrationFixKind` += `remove_line` + `RemoveLinePayload` + the `applyMigrationFix` case (`src/lib/migration-fix.ts`): payload identifies the line (`{ line_id }` / `{ shopify_variant_id }` / `{ title }`; matches only a line satisfying **every** field provided); idempotently removes the matched line from `items[]`, leaves all other lines + their `price_override_cents` untouched; fail-closed if a match would empty the sub; worker re-runs `verifyMigration`.
- ✅ the `migration-fix` skill's **remove-vs-backfill** decision rule: real product missing a `product_variants` row → `variant_backfill` (keep + remap); a free/promo line with no catalog identity ($0, no variant) → `remove_line` (delete); unsure → `needs_input`.
- ✅ Brain: [[../libraries/migration-fix]] (the five fixes) + [[migration-fix-agent]] (items_on_uuids backfill-or-remove + fix_kind enum) + [[../dashboard/migrations]] (action surfaced).
- ✅ **applied to `e4589de9`** (owner-approved): `scripts/fix-e4589de9-remove-line-protection.ts --apply` ran `remove_line { title: "ACV Gummies" }` + `shipping_protection_convert { amount_cents: 395, baseline_cents: 5996 }` then re-verified → `items_on_uuids` + `pricing_preserved` cleared, renews $63.91 (Tabs 5996 + protection 395), Tabs override untouched, row passed.
- Fold on ship.
