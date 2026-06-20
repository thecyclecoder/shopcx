# pricing_preserved must account for internal quantity breaks (Appstle baseline lacks them) ⏳

**Owner:** [[../functions/retention]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" · **Derived-from-migration:** `9505e4a3-9819-44ea-ac71-b51288edc494`

Stop migration_audits flagging false pricing_preserved failures when the internal catalog pricing rule legitimately applies a quantity break that the source Appstle contract never had. Today the baseline (pre_migration_charge_cents) is the sum of Appstle per-line currentPrice, which includes S&S but NOT our mix-and-match quantity breaks. The engine correctly applies those breaks on renewal, so any migrated multi-unit sub on a rule with a quantity break prices BELOW the baseline and fails-closed — and price_reconcile cannot repair it because the only knob (price_override_cents) is capped at MSRP and cannot raise the effective charge to cancel a break.

## Problem (from failed migration `9505e4a3-9819-44ea-ac71-b51288edc494`, sub `7390b640-e64b-4a33-9751-9dc4cfc24bb1`)
Audit 9505e4a3 (sub 7390b640): 2× Superfood Tabs, both base $79.95 = MSRP, not grandfathered. Appstle currentPrice $59.96/unit (25% S&S, no break) → pre 11992¢. Internal rule ed8ae5b4 has an 8% buy-2 break → engine 11034¢ (=$55.17/unit). The 958¢ shortfall is entirely the legitimate quantity break; the customer correctly bills less. pricing_preserved (|engine−pre|≤ tol) fails, and no price_reconcile can fix it (base would need $86.90 > MSRP $79.95, forbidden). Fix: when comparing, run the inferred Appstle base(s) through the internal engine (resolveSubscriptionPricing on the migrated items) and compare engine subtotal to THAT expected internal subtotal — OR allow the engine to fall short of the Appstle baseline by exactly the catalog quantity-break amount on the same bases. Must NOT blanket-accept engine<pre (that would mask real underpricing bugs) and must still fail when the customer would be charged MORE; tie the tolerated shortfall to the specific quantity-break the rule grants for the line's mix-and-match qty.

**Likely target:** `src/lib/migration-audit.ts (pricing_preserved check in runChecks; baseline capture in src/lib/migrate-to-internal.ts preCharge)`

## Phases
- ⏳ **P1 — close the gap** — scope from the problem above; land the code/data fix + its brain page; gate on `npx tsc --noEmit`.

## Verification
- Re-run `verifyMigration` on a migration that hit this gap → expect it to auto-heal/pass without a hand fix, and confirm the class of failure no longer recurs.

> Authored by the box migration-fix routine from failed migration `9505e4a3-9819-44ea-ac71-b51288edc494`. Commission the build from the Roadmap board (owner = retention).
