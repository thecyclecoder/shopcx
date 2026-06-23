# inngest/loop-heartbeats-prune

Daily retention prune of [[../tables/loop_heartbeats]] — deletes beats older than 3 days so the table stays small and the `control_tower_loop_beats` RPC stays fast ([[../specs/loop-heartbeats-retention]] Phase 1).

**File:** `src/lib/inngest/loop-heartbeats-prune.ts`

## Functions

### `loop-heartbeats-prune`
- **Trigger:** cron `30 8 * * *` (daily, 08:30 UTC — off-peak, before the 09:00 cron cluster)
- **Retries:** 1
- **What it deletes:** every `loop_heartbeats` row with `ran_at < now() - interval '3 days'` (`RETENTION_DAYS`). Heartbeats are pure recent-liveness signal — the monitor's windows are minutes→~26h and history is the latest ≤10 per loop, so anything older is dead weight. 3 days is the owner directive (2026-06-23): plenty for every window + the deploy/registered never-fired detection (which keys off PRESENCE of any historical beat, not count).
- **Batched, bounded, single-step:** the batch loop (select ≤500 ids → `delete .in(ids)`) runs INSIDE one `step.run("prune-old-beats")`, NOT one step per batch — so a large backlog can't explode the Inngest step count. Capped at `MAX_ROWS_PER_RUN` (500k) per run; steady-state it only clears ~1 day of beats, far under the cap.
- **Heartbeats:** itself a registered, monitored loop — emits `emitCronHeartbeat("loop-heartbeats-prune", …)` at end of run, so a DEAD pruner (table silently regrowing toward millions) is visible on the [[../dashboard/control-tower]]. Registry tile: `loop-heartbeats-prune` (owner platform, window 26h, `registeredAt` set for the registered-not-firing grace — see [[../libraries/control-tower]]).

## One-time backlog prune (out-of-band)

The cron prevents recurrence but is capped per run; the ~21M-row backlog found 2026-06-23 is cleared in one supervised pass by **`scripts/prune-loop-heartbeats-backlog.ts`** (ctid-batched DELETE + `VACUUM (ANALYZE)` to reclaim space + refresh planner stats). Connects via the SESSION pooler (:5432) because VACUUM is unsupported on the transaction pooler. Run once with owner authorization (a prod mutation).

## RPC relationship

The durable fix pairs with the already-index-backed `control_tower_loop_beats` RPC ([[../specs/control-tower-loop-beats-rpc-perf]]): its per-loop lateral rides the `(loop_id, ran_at desc)` index and its distinct-loop scan rides the partial `loop_heartbeats_active_kind_loop_idx` (index-only, NOT a full heap scan). Keeping the table at ~3 days keeps both small so the RPC stays under the statement timeout.

## Downstream events sent

_None._

## Tables written

- [[../tables/loop_heartbeats]] (deletes old rows; writes its own end-of-run beat)

## Tables read (not written)

_None besides the above._

---

[[../README]] · [[../integrations/inngest]] · [[../tables/loop_heartbeats]] · [[../libraries/control-tower]] · [[../specs/loop-heartbeats-retention]] · [[../../CLAUDE]]
