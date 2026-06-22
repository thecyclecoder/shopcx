# `src/lib/inngest/storefront-lever-decay.ts` — lever-importance decay + M3 intake

The re-probe clock for the lever-importance memory (M2, Phase 3/4). Daily, decays each lever posterior toward its prior as it ages (so a written-off lever resurrects for re-probing) and ingests the M3 reconciler's recalibration signal if present. Heavy lifting in [[../libraries/storefront-lever-memory]]. Spec `docs/brain/specs/storefront-lever-importance-memory.md`.

## Functions

| Function | Trigger | Does |
|---|---|---|
| `storefrontLeverDecayCron` | cron `0 13 * * *` (daily, +1h after the M1 attribution refresh) | Fan-out: finds every workspace with [[../tables/storefront_lever_importance]] rows and fires one `storefront/lever-decay` event each. |
| `storefrontLeverDecay` | event `storefront/lever-decay` (concurrency 1 per `workspace_id`) | Per-workspace worker: `decayLeverImportance` (drift posteriors toward prior by age) then `applyReconciliationSignal` (best-effort M3 intake). |

## Events
- **Listens:** `storefront/lever-decay` `{ workspace_id }`.
- **Sends:** `storefront/lever-decay` (cron → worker fan-out).

## Tables
- **Reads/writes:** [[../tables/storefront_lever_importance]] (recompute `importance` from prior + evidence + age; idempotent).
- **Reads:** [[../tables/storefront_levers]]; `storefront_ltv_reconciliations` (M3, best-effort — absent until M3 ships).

## Gotchas
- **Mirrors the M1 cadence.** Same daily schedule as [[storefront-experiments]], offset +1h so decay lands after the day's experiment learnings have committed.
- **Idempotent.** Decay recomputes `importance` from source each run (prior + evidence + age) — it never compounds. M3 intake is deduped by `m3:<reconciliation_id>` in `evidence`.
- **Registered** in `src/lib/inngest/registered-functions.ts` (both functions) — the serve route picks them up.
