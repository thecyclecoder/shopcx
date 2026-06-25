# Register monitored loop: spec-review-cron ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the [[control-tower-complete-coverage]] coverage self-audit · auto-proposed by [[../libraries/coverage-register-agent]].

The coverage self-audit found a cron `createFunction` served in code (`spec-review-cron`, every 15 min (*/15 * * * *)) with **no `MONITORED_LOOPS` tile** — an unregistered loop. This spec adds the inferred registry entry so the loop becomes a real monitored tile. Confirm the inferred **owner-function** (`platform`) + cadence/window before merging.

## Phase 1 — add the MONITORED_LOOPS entry ⏳
In `src/lib/control-tower/registry.ts`, add this entry to `MONITORED_LOOPS` (in the Inngest crons group):

```ts
  {
    id: "spec-review-cron",
    kind: "cron",
    owner: "platform",
    label: "spec-review-cron",
    description: "Auto-proposed monitored loop for the spec-review-cron cron (every 15 min (*/15 * * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "every 15 min (*/15 * * * *)",
    livenessWindowMs: 1 * HOUR,
  },
```

No other change. After merge + deploy the amber "unregistered loop: spec-review-cron" gap clears and a `spec-review-cron` cron tile appears.

## Verification
- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: spec-review-cron".
- A `spec-review-cron` cron tile appears in the monitored loops grid (green once it has beaten, amber "awaiting first run" until then — never a false red).

<!-- coverage-register: register-loop-spec-review-cron for loop spec-review-cron -->
