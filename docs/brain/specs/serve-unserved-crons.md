# Serve (or retire) the unserved crons — deliver-pending-sends + marketing-text-campaign-send-tick ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower-complete-coverage]] (the never-fired check caught this). · **Blocked-by:** [[control-tower-monitor-accuracy]] (so the verification reads true once false-positives clear).

The Control Tower's never-fired check correctly flagged **`deliver-pending-sends`** and **`marketing-text-campaign-send-tick`** with **0 heartbeats ever**. Root cause: both are defined (`src/lib/inngest/deliver-pending-send.ts`, `marketing-text.ts`) **with `emitCronHeartbeat` wired**, and both are in the Control Tower registry — but **neither is imported into the Inngest serve route** (`src/app/api/inngest/route.ts`). Inngest only runs functions in the serve array, so these two **never fire** — silent dead crons. This is exactly the in-code-vs-Inngest-registered gap the self-audit targets.

## Fix — decide per cron, then make code + registry agree
For each of the two: determine whether it **should** run.
- **Should run** → import + add it to the serve route's `functions` array (`src/app/api/inngest/route.ts`) so Inngest invokes it. It'll start beating → tile green.
- **Intentionally retired** → remove the function (and its registry entry) OR add it to `INTENTIONALLY_UNMONITORED_CRONS` with a reason, so the Control Tower doesn't flag a deliberately-disabled cron. Silence is never the default — an exemption carries a reason.
- Check whether their work is **covered elsewhere** (e.g. another send/dispatch path superseded `deliver-pending-sends` / `marketing-text-campaign-send-tick`) before re-serving — don't resurrect a duplicate.

## Verification
- After the fix, neither appears in the Control Tower never-fired set: a re-served cron emits a heartbeat within its cadence (tile green); a retired one is gone from the registry or shows as intentionally-unmonitored (no red).
- The self-audit's in-code-vs-Inngest-registered diff (once live) reports **0 served-route gaps** for these two.

## Phase 1 — serve-or-retire decision + wiring ⏳
Investigate both crons' intent + current coverage; serve (add to the route) or retire (remove / exempt). Brain: [[../inngest]] (the cron index + serve route) · [[control-tower-complete-coverage]] · [[control-tower]].
