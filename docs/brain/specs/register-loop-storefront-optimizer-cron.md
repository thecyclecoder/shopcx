# Register monitored loop: storefront-optimizer-cron ⏳

**Owner:** [[../functions/growth]] · **Parent:** extends the [[control-tower-complete-coverage]] coverage self-audit · auto-proposed by [[../libraries/coverage-register-agent]].

The coverage self-audit found a cron `createFunction` served in code (`storefront-optimizer-cron`, daily (30 14 * * *)) with **no `MONITORED_LOOPS` tile** — an unregistered loop. This spec adds the inferred registry entry so the loop becomes a real monitored tile. Confirm the inferred **owner-function** (`growth`) + cadence/window before merging.

## Phase 1 — add the MONITORED_LOOPS entry ⏳
In `src/lib/control-tower/registry.ts`, add this entry to `MONITORED_LOOPS` (in the Inngest crons group):

```ts
  {
    id: "storefront-optimizer-cron",
    kind: "cron",
    owner: "growth",
    label: "storefront-optimizer-cron",
    description: "Auto-proposed monitored loop for the storefront-optimizer-cron cron (daily (30 14 * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "daily (30 14 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-23T16:00:06.292Z",
  },
```

No other change. After merge + deploy the amber "unregistered loop: storefront-optimizer-cron" gap clears and a `storefront-optimizer-cron` cron tile appears.

## Verification
- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: storefront-optimizer-cron".
- A `storefront-optimizer-cron` cron tile appears in the monitored loops grid (green once it has beaten, amber "awaiting first run" until then — never a false red).

<!-- coverage-register: register-loop-storefront-optimizer-cron for loop storefront-optimizer-cron -->
