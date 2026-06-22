# Control Tower Monitor Accuracy — never-fired uses "0 beats ever" + lighter loop_heartbeats reads ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower]] + [[control-tower-complete-coverage]]. Fixes a false-positive class + a self-inflicted error.

The never-fired detection ([[control-tower-complete-coverage]] P2) is **false-flagging healthy crons red**. It keys off **"0 heartbeats *since deploy*"**, so any cron whose real cadence is longer than its `livenessWindowMs` (e.g. a daily `today-sync`, the frequent-but-bursty `meta-capi-dispatch`) goes **red `never_fired`** after a deploy even though it has beat **99 / 494 times** historically. Observed: today-sync (99 beats), meta-capi (494), abandoned-cart, slack-roadmap, migration-audit-retry all red while genuinely healthy. Same deploy-boundary class we already fixed for inline agents. Separately, the monitor's own **`GET /rest/v1/loop_heartbeats` is 500-ing** (captured in the Supabase feed) — the snapshot reads beats for 49+ loops and the query has grown too heavy.

## Fix
- **Never-fired = 0 beats EVER, not 0-since-deploy.** A cron with *any* heartbeat in `loop_heartbeats` history is being invoked → never `never_fired` (at most a freshness alert if it's overdue vs its *real* cadence). Only a cron with **zero beats in all of history**, past deploy-age + window, is `never_fired` (the genuine "Inngest isn't invoking it" signal — e.g. the truly-unserved crons in [[serve-unserved-crons]]). Mirrors the inline-agent never-run grace.
- **Cadence-aware freshness (optional, if cheap):** for a cron that *has* history, "stale" should compare against its actual inter-beat cadence, not the tight liveness window — so a daily cron isn't stale at 27m.
- **Lighter loop_heartbeats reads:** the snapshot's per-loop beat fetch must not 500. Bound it — one windowed/aggregated query (e.g. latest beat per loop_id via a single grouped read or a capped window) instead of a fan-out that scans the whole table; add the index it needs (`(loop_id, ran_at desc)`) if missing. The Control Tower must not be a source of its own errors.

## Verification
- today-sync / meta-capi-dispatch (have historical beats) → **green/amber by real cadence, never red `never_fired`**; their open `never_fired` alerts auto-resolve next monitor tick.
- A cron with **0 beats ever** past deploy+window → still **red `never_fired`** (the real signal preserved — re-validates deliver-pending-sends).
- The Supabase feed shows **no new `500 GET /rest/v1/loop_heartbeats`** after the read is bounded; the snapshot still renders every loop.

## Phase 1 — ever-beats never-fired + bounded loop_heartbeats read ⏳
`evalCron` never-fired keys off all-time beat count (0 ⇒ candidate; ≥1 ⇒ not never-fired); bound/aggregate the snapshot's loop_heartbeats query (+ index). Brain: [[../libraries/control-tower]] (evalCron, fetch) · [[../tables/loop_heartbeats]] · [[control-tower]].
