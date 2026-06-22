# inngest/storefront-lever-memory

The maintenance loop for the lever-importance memory (Phase 3/4 of the lever-importance model + CRO-learnings memory spec). Decays every learned posterior toward its prior with age (keeps a written-off lever explorable) and intakes the M3 reconciler's recalibration signal if present. Thin wrappers over [[../libraries/lever-memory]].

**File:** `src/lib/inngest/storefront-lever-memory.ts` · See [[../libraries/lever-memory]], [[../tables/storefront_lever_importance]]. Part of [[../goals/storefront-optimizer]] (M2).

## Functions

### `storefront-lever-memory-decay-cron`
- **Trigger:** cron `30 12 * * *` (daily, 30 min AFTER [[storefront-experiments]]' refresh so freshly-committed posteriors decay on the next pass)
- **Retries:** 1
- Finds every workspace with a [[../tables/storefront_lever_importance]] row and fires one `storefront/lever-memory-decay` event each.

### `storefront-lever-memory-decay`
- **Trigger:** event `storefront/lever-memory-decay`
- **Retries:** 2 · **Concurrency:** `[{ limit: 1, key: "event.data.workspace_id" }]`
- **Event data:** `{ workspace_id }`
- Calls `decayLeverImportance()` then `applyReconcilerSignals()` — drift posteriors toward prior, then apply any M3 recalibration signal.

## Gotchas

- **Decay never erases evidence.** It only adjusts `importance`; `evidence`/`last_tested_at` are untouched, so a fresh experiment recomputes the posterior at full strength and resets the decay clock.
- **Reconciler intake is a soft dependency.** `applyReconcilerSignals` is a no-op until M3's [[../specs/storefront-ltv-proxy-reconciler]] ships `storefront_lever_recalibration`.

---

[[../README]] · [[../../CLAUDE]]
