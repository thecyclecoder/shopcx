# Register monitored loop: acquisition-research-cadence-cron ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the [[control-tower-complete-coverage]] coverage self-audit · auto-proposed by [[../libraries/coverage-register-agent]].

The coverage self-audit found a cron `createFunction` served in code (`acquisition-research-cadence-cron`, daily (0 10 * * *)) with **no `MONITORED_LOOPS` tile** — an unregistered loop. This spec adds the inferred registry entry so the loop becomes a real monitored tile. Confirm the inferred **owner-function** (`platform`) + cadence/window before merging.

## Phase 1 — add the MONITORED_LOOPS entry ⏳
In `src/lib/control-tower/registry.ts`, add this entry to `MONITORED_LOOPS` (in the Inngest crons group):

```ts
  {
    id: "acquisition-research-cadence-cron",
    kind: "cron",
    owner: "platform",
    label: "acquisition-research-cadence-cron",
    description: "Auto-proposed monitored loop for the acquisition-research-cadence-cron cron (daily (0 10 * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "daily (0 10 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-25T14:30:03.155Z",
  },
```

No other change. After merge + deploy the amber "unregistered loop: acquisition-research-cadence-cron" gap clears and a `acquisition-research-cadence-cron` cron tile appears.

## Verification
- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: acquisition-research-cadence-cron".
- A `acquisition-research-cadence-cron` cron tile appears in the monitored loops grid (green once it has beaten, amber "awaiting first run" until then — never a false red).

<!-- coverage-register: register-loop-acquisition-research-cadence-cron for loop acquisition-research-cadence-cron -->
