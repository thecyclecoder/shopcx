# Saturate the build pool — keep all 8 lanes full, not 4 per 15 min ✅

**Priority:** critical

**Owner:** [[../functions/platform]] · **Parent:** [[director-initialize-platform-specs-no-wait]] — opens the throughput throttle on the initiation/groom lanes under [[../goals/devops-director]]
**Found in use 2026-06-24:** build capacity is `MAX_CONCURRENT = 8` lanes, but the director enqueues at most `PLATFORM_DIRECTOR_INIT_CAP = 4` (+ `GROOM_CAP = 4`) per pass, runs the soundness investigations SEQUENTIALLY (a slow Max call each), fires the [[../inngest/platform-director-cron]] only every 15 min, and escalates sound specs instead of building them. Snapshot: 6/8 lanes building, 0 queued, 2 idle — the pool runs under-fed. The CEO: 'we have 8 lanes, why not fill them?'

## North star — saturate, but respect the real ceiling

The binding constraint is NOT the box or the lane count — it's **Max rate limits** (the `MAX_CONCURRENT` comment warns to watch for Max 529/overloaded). So 'fill the lanes' targets lane capacity AND backs off on 529s. The soundness rail, loop-guard, dedup, and escalation-of-destructive all stay — this changes the RATE, not the safety.

## Phase 1 — target queue depth = lane capacity (kill the fixed per-pass cap) ✅
- ✅ shipped — `BUILD_POOL_CAPACITY` (8, synced with `MAX_CONCURRENT`) + `idleBuildCapacity(admin, ws)` = `max(0, BUILD_POOL_CAPACITY − in-flight build/plan jobs)` in [[../libraries/platform-director]]. `findInitCandidates` + `findGroomCandidates` each cap at `min(CAP, idleBuildCapacity)` and return `[]` when the pool is full — so a pass tops up exactly the idle lanes (8 idle → fill 8, 2 idle → 2, full → 0). Counting queued+claimed+building+needs_input+needs_approval+queued_resume means a build queued earlier in the same pass shrinks the target for the next lane → never over-fills. `PLATFORM_DIRECTOR_INIT_CAP` / `PLATFORM_DIRECTOR_GROOM_CAP` are now both `= BUILD_POOL_CAPACITY` (the absolute safety ceiling; the saturation target binds first).
- ✅ loop-guard + `hasActiveBuildForSlug` dedup unchanged — no spec double-queues, a repeatedly-failing build still escalates.

### Verification — Phase 1
- With ≥8 eligible specs and an empty queue, one pass enqueues enough to fill all 8 lanes (not 4). With 6 lanes busy, a pass tops up only the 2 idle. No double-queue; no over-fill beyond capacity.

## Phase 2 — parallel investigations + lean toward initiate ✅
- ✅ shipped — `initiatePlatformSpecs` (`scripts/builder-worker.ts`) now runs its per-candidate soundness investigations CONCURRENTLY via a bounded worker-pool (`runWithConcurrency`, `DIRECTOR_INVEST_CONCURRENCY`=4) instead of the sequential loop — one pass produces a full batch. Each task owns its own spec's DB writes (no contention); counters aggregate safely under JS's single-threaded await.
- ✅ gate already calibrated — `initInvestigationPrompt` INITIATES a sound + in-scope + additive spec and reserves ESCALATE for ambiguous / out-of-scope / new-goal / destructive / a choice (CEO soundness rail, 2026-06-24). No change needed; verified in place.

### Verification — Phase 2
- A pass with N sound candidates initiates them in parallel within the pass (not one-per-cron-cycle). The init_unsure-escalation-to-initiation ratio drops sharply.

## Phase 3 — refill fast: event-driven top-up + a tighter beat ✅
- ✅ shipped — `enqueueDirectorTopUp(workspaceId)` ([[../libraries/agent-jobs]]) enqueues one `platform-director` standing-pass job (deduped on a PENDING pass: `queued｜queued_resume`) and is fired from `applyMergedBuildEffects` step (6), so BOTH merge paths (manual reconcile + auto-merge webhook) refill a freed lane within seconds.
- ✅ tightened the cron [[../inngest/platform-director-cron]] 15 → 5 min as the backstop heartbeat; the in-flight dedupe prevents pileup.

### Verification — Phase 3
- A completing build triggers a top-up that refills the freed lane within one cycle (not the next 15-min tick). The queue depth tracks lane capacity continuously.

## Phase 4 — Max-rate-limit guardrail + visibility ✅
- ✅ shipped — the init lane backs off on Max 529/overloaded: `isMaxOverloaded` checks each investigation result; a throttle mid-batch sets an `overloaded` flag that skips the remaining candidates (escalating nothing — it's a transient API throttle, not a spec problem) and resumes next beat. The bounded concurrency (Phase 2) already caps the simultaneous Max load.
- ✅ visibility — two new daily KPIs in [[../libraries/platform-scorecard]] → [[../tables/platform_scorecard_snapshots]]: `lane_utilization` (build/plan jobs occupying a lane ÷ `BUILD_POOL_CAPACITY`, capped at 1 — the headline saturation curve) + `build_enqueue_rate` (builds enqueued in-window — the feed rate). They snapshot on the standing-cron daily pulse and render on the (forthcoming) scorecard surface generically.

### Verification — Phase 4
- Under a Max 529 burst, the director throttles enqueuing and resumes on recovery (no runaway). The scorecard shows lane utilization trending toward full.

## Verification
- **Phase 1 (saturation):** with Platform live+autonomous, ≥8 eligible unstarted specs, and an empty queue, watch one standing pass on `/dashboard/roadmap/box` (or the box logs `init: assessed N → initiated N`) → expect it to queue up to all idle lanes (8 from empty), not 4. With 6 lanes busy → expect a pass tops up only the 2 idle. No spec double-queues (the `hasActiveBuildForSlug` guard); no in-flight count exceeds `BUILD_POOL_CAPACITY`.
- **Phase 2 (parallel):** in the box log for a pass with N sound candidates, the `init … → initiate → queued build` lines appear within ONE pass (overlapping timestamps from the bounded pool), not one-per-cron-cycle. The init→escalation ratio for sound specs is ~0 (sound specs initiate, not escalate).
- **Phase 3 (refill):** merge a `claude/*` build PR → within seconds a new `kind='platform-director'` `agent_jobs` row appears (`instructions` mentions "event-driven top-up") and the freed lane refills on the next pass, not on a 15-min boundary. Confirm the cron is `*/5` in [[../inngest/platform-director-cron]]. A burst of merges never queues >1 pending platform-director job.
- **Phase 4 (guardrail + KPIs):** during a Max 529 burst, the box log shows `init … → Max 529/overloaded — backing off the rest of this pass` and the pass ends (`backed off on Max 529` in the summary) — no runaway hammering; the next pass resumes. On the Platform Department Scorecard / `platform_scorecard_snapshots`, the `lane_utilization` (ratio) + `build_enqueue_rate` (count) rows appear daily and `lane_utilization` trends toward 1.0 as the pool saturates.
- `npx tsc --noEmit` clean.

## Open decision (for the CEO)
How hard to push past 8: the box (CCX33, 8-core/30GB) sat at ~14% load on 5 lanes, so it has headroom — but Max rate limits are the wall. Default: saturate to 8 with a 529-backoff and watch box/Max logs before bumping MAX_CONCURRENT higher. Say the word to raise the lane count itself (separate from this spec, which fills whatever the count is).