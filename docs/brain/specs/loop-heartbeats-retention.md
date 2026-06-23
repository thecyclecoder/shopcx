# loop_heartbeats retention — prune so the Control Tower RPC stays fast ✅

**Owner:** [[../functions/platform]] · **Parent:** keeps [[control-tower]] readable; relates to [[control-tower-loop-beats-rpc-perf]]. · **Found in use 2026-06-23:** `loop_heartbeats` grew to **21M rows / 4.5 GB** with **no retention** — the `control_tower_loop_beats` RPC times out (`57014`, 4-5s when it works, 53 failures today), so `monitor.ts:283` falls back to **"beat read unavailable — status unknown"** for ~every card. The whole Control Tower went blind. The rpc-perf fix (lateral + index) isn't enough at 21M rows.

**Root cause (2026-06-23): a runaway writer, not just missing retention.** `feed:vercel` was emitting **~175 beats/SECOND** (a heartbeat per Vercel log-drain delivery) — 21.7M of the 21.7M rows. Fixed by throttling `recordFeedDelivery` to ≤1/min/source (shipped) + TRUNCATE reset. Retention below is the defense-in-depth so NO writer can ever balloon the table again.

Heartbeats are pure liveness signal — the monitor only needs **recent** beats (windows are minutes→~26h; history is the latest N per loop). Anything older than a few days is dead weight. Retain **24 hours** (owner directive 2026-06-23 — covers every window incl. the ~26h daily-cron grace via the last beat; the never-fired/registered-not-firing guards key off the watchdog's own recent beats, not week-old history).

## Fix
- **Ongoing retention (the durable fix):** a small daily prune — either a dedicated `loop-heartbeats-prune` cron, or fold it into an existing daily cron, deleting `loop_heartbeats where ran_at < now() - interval '24 hours'` in batches. Itself a registered, heartbeating loop (so a dead pruner is visible). This keeps the table small permanently so the RPC stays fast.
- **One-time backfill prune:** delete the ~21M-row backlog down to 3 days (batched, ctid-based, to avoid a long lock), then `VACUUM (ANALYZE)` to reclaim space + refresh the planner. (Done out-of-band with owner authorization; the cron prevents recurrence.)
- **Belt-and-suspenders on the RPC:** confirm `control_tower_loop_beats` uses the `(loop_id, ran_at desc)` index for its per-loop lateral and isn't doing a full-table `distinct loop_id` scan; if it is, drive the distinct-loop list from `MONITORED_LOOPS` (a fixed ~50-entry set) instead of scanning the table.

## Verification
- After the one-time backlog prune runs (`npx tsx scripts/prune-loop-heartbeats-backlog.ts`, owner-authorized) → expect its log shows "rows after" ≈ 3 days of beats (not ~21M), `VACUUM (ANALYZE) complete`, and `control_tower_loop_beats(20) returned N rows in <1000ms`.
- On the DB, `select count(*) from loop_heartbeats where ran_at < now() - interval '3 days'` → expect 0 within a day of the cron firing (and 0 immediately after the backlog script).
- In Inngest Cloud, the `loop-heartbeats-prune` function appears with a `30 8 * * *` schedule and runs daily → expect a daily run that returns `{ deleted, batches, cutoff, capped:false }` and a fresh `loop_heartbeats` row with `loop_id='loop-heartbeats-prune'`, `kind='cron'`.
- On the [[../dashboard/control-tower]] (`GET /api/developer/control-tower`) → expect a green "Loop heartbeats prune" tile under Platform (amber "awaiting first run" only until its first 08:30 UTC tick, never a false `registered_not_firing` red — `registeredAt` grace), and every cron tile shows real green/red status, NOT "beat read unavailable — status unknown."
- On the DB, `explain (analyze) select * from control_tower_loop_beats(20)` → expect index scans on `loop_heartbeats_loop_ran_idx` (the `(loop_id, ran_at desc)` lateral) + `loop_heartbeats_active_kind_loop_idx` (the distinct), no Seq Scan of `loop_heartbeats`, total time < 1s, no `57014`.
- The originating `api 500 POST /rest/v1/rpc/control_tower_loop_beats` error stops recurring (no new occurrences in the error feed after the prune).
- Over a week, `select count(*) from loop_heartbeats` stays bounded (≈ 3 days × beat rate) and does not regrow toward millions.

## Phase 1 — retention cron + RPC distinct-loop fix ✅
A daily batched prune (`ran_at < now() - 3 days`) registered as a monitored loop; verify/​fix the RPC's distinct-loop source. (The one-time 21M-row backlog prune is run with owner authorization alongside.) Brain: [[../libraries/control-tower]] · [[control-tower]] · [[control-tower-loop-beats-rpc-perf]] · [[../tables/loop_heartbeats]].

**Shipped:**
- New daily cron **`loop-heartbeats-prune`** (`src/lib/inngest/loop-heartbeats-prune.ts`, `30 8 * * *`) — deletes `loop_heartbeats where ran_at < now() - interval '3 days'` in ≤500-id batches inside ONE `step.run` (no per-batch step explosion), capped at 500k rows/run. Emits its own end-of-run `emitCronHeartbeat("loop-heartbeats-prune", …)`. Registered in `registered-functions.ts` + as a monitored tile in `registry.ts` (owner platform, window 26h, `registeredAt` for the new-cron registered-not-firing grace). Brain: [[../inngest/loop-heartbeats-prune]].
- **One-time backlog prune** authored as `scripts/prune-loop-heartbeats-backlog.ts` (ctid-batched DELETE + `VACUUM (ANALYZE)`, session pooler :5432) — run once with owner authorization.
- **RPC verified, no change needed:** `control_tower_loop_beats` (`20260622170000_control_tower_loop_beats_lateral.sql`) ALREADY (1) rides the `(loop_id, ran_at desc)` index for its per-loop lateral and (2) drives its distinct-loop scan off the partial `loop_heartbeats_active_kind_loop_idx on (loop_id) where kind not in ('inline-agent','reactive')` — an index-only scan, NOT a full-table `distinct loop_id` heap scan. The belt-and-suspenders "drive distinct from `MONITORED_LOOPS`" rewrite was the fallback IF it were a full scan; it isn't, so the prune (keeping the table at ~3 days) is the durable fix that keeps both index scans small.
