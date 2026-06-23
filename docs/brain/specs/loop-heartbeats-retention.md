# loop_heartbeats retention — prune so the Control Tower RPC stays fast ⏳

**Owner:** [[../functions/platform]] · **Parent:** keeps [[control-tower]] readable; relates to [[control-tower-loop-beats-rpc-perf]]. · **Found in use 2026-06-23:** `loop_heartbeats` grew to **21M rows / 4.5 GB** with **no retention** — the `control_tower_loop_beats` RPC times out (`57014`, 4-5s when it works, 53 failures today), so `monitor.ts:283` falls back to **"beat read unavailable — status unknown"** for ~every card. The whole Control Tower went blind. The rpc-perf fix (lateral + index) isn't enough at 21M rows.

Heartbeats are pure liveness signal — the monitor only needs **recent** beats (windows are minutes→~26h; history is the latest N per loop). Anything older than a few days is dead weight. Retain **3 days** (owner directive 2026-06-23 — plenty for every window + never-fired/registered-not-firing detection).

## Fix
- **Ongoing retention (the durable fix):** a small daily prune — either a dedicated `loop-heartbeats-prune` cron, or fold it into an existing daily cron, deleting `loop_heartbeats where ran_at < now() - interval '3 days'` in batches. Itself a registered, heartbeating loop (so a dead pruner is visible). This keeps the table small permanently so the RPC stays fast.
- **One-time backfill prune:** delete the ~21M-row backlog down to 3 days (batched, ctid-based, to avoid a long lock), then `VACUUM (ANALYZE)` to reclaim space + refresh the planner. (Done out-of-band with owner authorization; the cron prevents recurrence.)
- **Belt-and-suspenders on the RPC:** confirm `control_tower_loop_beats` uses the `(loop_id, ran_at desc)` index for its per-loop lateral and isn't doing a full-table `distinct loop_id` scan; if it is, drive the distinct-loop list from `MONITORED_LOOPS` (a fixed ~50-entry set) instead of scanning the table.

## Verification
- After prune + retention: `select count(*) from loop_heartbeats` is small (≈ 3 days × beat rate, not 21M); `control_tower_loop_beats(p_history_limit=20)` returns in < 1s (no `57014` timeout); the Control Tower cards show real status (green/red), not "beat read unavailable."
- The prune cron runs daily, beats, and keeps the row count bounded over a week (doesn't regrow toward millions).
- A monitored cron's freshness/never-fired detection still works on 3 days of history (no false "never fired" from over-pruning).
- The originating `api 500 POST /rest/v1/rpc/control_tower_loop_beats` error stops recurring.

## Phase 1 — retention cron + RPC distinct-loop fix ⏳
A daily batched prune (`ran_at < now() - 3 days`) registered as a monitored loop; verify/​fix the RPC's distinct-loop source. (The one-time 21M-row backlog prune is run with owner authorization alongside.) Brain: [[../libraries/control-tower]] · [[control-tower]] · [[control-tower-loop-beats-rpc-perf]] · [[../tables/loop_heartbeats]].
