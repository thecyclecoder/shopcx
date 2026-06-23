# Register monitored loop: storefront-ltv-reconcile-cron ✅

**Owner:** [[../functions/growth]] · **Parent:** extends the [[control-tower-complete-coverage]] coverage self-audit · auto-proposed by [[../libraries/coverage-register-agent]].

The coverage self-audit found a cron `createFunction` served in code (`storefront-ltv-reconcile-cron`, daily (0 14 * * *)) with **no `MONITORED_LOOPS` tile** — an unregistered loop. This spec adds the inferred registry entry so the loop becomes a real monitored tile. Confirm the inferred **owner-function** (`growth`) + cadence/window before merging.

## Phase 1 — add the MONITORED_LOOPS entry ✅
In `src/lib/control-tower/registry.ts`, add this entry to `MONITORED_LOOPS` (in the Inngest crons group):

```ts
  {
    id: "storefront-ltv-reconcile-cron",
    kind: "cron",
    owner: "growth",
    label: "storefront-ltv-reconcile-cron",
    description: "Auto-proposed monitored loop for the storefront-ltv-reconcile-cron cron (daily (0 14 * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "daily (0 14 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-23T16:00:05.906Z",
  },
```

No other change. After merge + deploy the amber "unregistered loop: storefront-ltv-reconcile-cron" gap clears and a `storefront-ltv-reconcile-cron` cron tile appears.

## Verification
- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: storefront-ltv-reconcile-cron".
- A `storefront-ltv-reconcile-cron` cron tile appears in the monitored loops grid (green once it has beaten, amber "awaiting first run" until then — never a false red).

<!-- coverage-register: register-loop-storefront-ltv-reconcile-cron for loop storefront-ltv-reconcile-cron -->
