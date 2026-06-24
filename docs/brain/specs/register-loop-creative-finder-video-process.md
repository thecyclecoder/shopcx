# Register monitored loop: creative-finder-video-process ✅

**Owner:** [[../functions/platform]] · **Parent:** extends the [[control-tower-complete-coverage]] coverage self-audit · auto-proposed by [[../libraries/coverage-register-agent]].

The coverage self-audit found a cron `createFunction` served in code (`creative-finder-video-process`, daily (30 9 * * *)) with **no `MONITORED_LOOPS` tile** — an unregistered loop. This spec adds the inferred registry entry so the loop becomes a real monitored tile. Confirm the inferred **owner-function** (`platform`) + cadence/window before merging.

## Phase 1 — add the MONITORED_LOOPS entry ✅
In `src/lib/control-tower/registry.ts`, add this entry to `MONITORED_LOOPS` (in the Inngest crons group):

```ts
  {
    id: "creative-finder-video-process",
    kind: "cron",
    owner: "platform",
    label: "creative-finder-video-process",
    description: "Auto-proposed monitored loop for the creative-finder-video-process cron (daily (30 9 * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "daily (30 9 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-24T15:00:08.171Z",
  },
```

No other change. After merge + deploy the amber "unregistered loop: creative-finder-video-process" gap clears and a `creative-finder-video-process` cron tile appears.

## Verification
- ✅ On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: creative-finder-video-process".
- A `creative-finder-video-process` cron tile appears in the monitored loops grid (green once it has beaten, amber "awaiting first run" until then — never a false red).

<!-- coverage-register: register-loop-creative-finder-video-process for loop creative-finder-video-process -->
