# Saturate the build pool — keep all 8 lanes full, not 4 per 15 min ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[director-initialize-platform-specs-no-wait]] — opens the throughput throttle on the initiation/groom lanes under [[../goals/devops-director]]
**Found in use 2026-06-24:** build capacity is `MAX_CONCURRENT = 8` lanes, but the director enqueues at most `PLATFORM_DIRECTOR_INIT_CAP = 4` (+ `GROOM_CAP = 4`) per pass, runs the soundness investigations SEQUENTIALLY (a slow Max call each), fires the [[../inngest/platform-director-cron]] only every 15 min, and escalates sound specs instead of building them. Snapshot: 6/8 lanes building, 0 queued, 2 idle — the pool runs under-fed. The CEO: 'we have 8 lanes, why not fill them?'

## North star — saturate, but respect the real ceiling

The binding constraint is NOT the box or the lane count — it's **Max rate limits** (the `MAX_CONCURRENT` comment warns to watch for Max 529/overloaded). So 'fill the lanes' targets lane capacity AND backs off on 529s. The soundness rail, loop-guard, dedup, and escalation-of-destructive all stay — this changes the RATE, not the safety.

## Phase 1 — target queue depth = lane capacity (kill the fixed per-pass cap) ⏳
- Replace the fixed `INIT_CAP`/`GROOM_CAP` ceilings with a SATURATION target: each pass computes idle capacity = `MAX_CONCURRENT` − (active build jobs) and enqueues that many sound specs to fill the pool. When lanes are full, enqueue nothing; when 2 are idle, fill 2; when 8, fill 8. The pool stays topped up whenever eligible work exists.
- Keep loop-guard + `hasActiveBuildForSlug` dedup so no spec double-queues and a repeatedly-failing build still escalates.
- Brain: [[../libraries/platform-director]] (`findInitCandidates`, `findGroomCandidates`, the caps) · `scripts/builder-worker.ts` (`initiatePlatformSpecs`, `groomBoard`).

### Verification — Phase 1
- With ≥8 eligible specs and an empty queue, one pass enqueues enough to fill all 8 lanes (not 4). With 6 lanes busy, a pass tops up only the 2 idle. No double-queue; no over-fill beyond capacity.

## Phase 2 — parallel investigations + lean toward initiate ⏳
- Run the per-candidate soundness investigations CONCURRENTLY (bounded by a Max-safe concurrency limit) instead of the sequential loop, so a single pass produces a full batch instead of a trickle.
- Calibrate the gate: a sound, in-scope, unblocked platform spec is INITIATED, not escalated; ESCALATE is reserved for destructive / new-goal / out-of-scope / unconfirmable. Stops wasting passes (and your inbox) on 'needs a call' for sound specs.

### Verification — Phase 2
- A pass with N sound candidates initiates them in parallel within the pass (not one-per-cron-cycle). The init_unsure-escalation-to-initiation ratio drops sharply.

## Phase 3 — refill fast: event-driven top-up + a tighter beat ⏳
- Add an event-driven top-up: when a `build` job completes/merges (a lane frees), trigger a director top-up enqueue so the freed lane refills immediately rather than waiting up to 15 min. Keep the cron as the backstop heartbeat but tighten it (15 → ~5 min). The existing cron dedupe prevents pileup.
- Net: lanes refill within seconds of freeing, not on a 15-min boundary — the pool stays saturated end-to-end.

### Verification — Phase 3
- A completing build triggers a top-up that refills the freed lane within one cycle (not the next 15-min tick). The queue depth tracks lane capacity continuously.

## Phase 4 — Max-rate-limit guardrail + visibility ⏳
- Back off enqueuing/investigations on Max 529/overloaded (the real ceiling) — don't hammer a throttled API; resume when it clears. Surface lane utilization (lanes busy / 8) + enqueue rate on the [[Platform Department Scorecard]] so saturation is a visible KPI.

### Verification — Phase 4
- Under a Max 529 burst, the director throttles enqueuing and resumes on recovery (no runaway). The scorecard shows lane utilization trending toward full.

## Open decision (for the CEO)
How hard to push past 8: the box (CCX33, 8-core/30GB) sat at ~14% load on 5 lanes, so it has headroom — but Max rate limits are the wall. Default: saturate to 8 with a 529-backoff and watch box/Max logs before bumping MAX_CONCURRENT higher. Say the word to raise the lane count itself (separate from this spec, which fills whatever the count is).