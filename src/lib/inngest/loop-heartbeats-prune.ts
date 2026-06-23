import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/**
 * loop_heartbeats retention prune (loop-heartbeats-retention spec, Phase 1).
 *
 * loop_heartbeats is the Control Tower's per-run liveness log — pure recent-liveness
 * signal (windows are minutes→~26h; history is the latest ≤10 per loop). With NO
 * retention it grew to ~21M rows / 4.5 GB and the control_tower_loop_beats RPC began
 * timing out (57014), blinding the whole Control Tower ("beat read unavailable").
 *
 * This daily cron keeps the table small PERMANENTLY: it deletes every beat older than
 * RETENTION_DAYS so the RPC's lateral + partial-index distinct stay fast. It is itself a
 * registered, heartbeating monitored loop (registry.ts: "loop-heartbeats-prune") so a
 * DEAD pruner is visible on the Control Tower — the table regrowing toward millions would
 * otherwise be silent.
 *
 * Bounded by construction: it deletes in batches inside a SINGLE step.run (one internal
 * loop, capped at MAX_ROWS_PER_RUN) — NOT one step.run per batch — so a large backlog can't
 * explode the Inngest step count. Steady-state it only ever clears ~1 day of beats, well
 * under the cap. The ONE-TIME ~21M-row backlog is pruned out-of-band (ctid-batched + VACUUM)
 * via scripts/prune-loop-heartbeats-backlog.ts with owner authorization; this cron prevents
 * recurrence.
 */

// Owner directive 2026-06-23: 3 days is plenty for every window (minutes→~26h) + the
// deploy/registered never-fired detection (which keys off PRESENCE of any historical beat).
const RETENTION_DAYS = 3;
// Small `.in(ids)` batches keep the PostgREST URL well under any length limit (cf. auto-archive).
const BATCH_SIZE = 500;
// Per-run safety cap: steady-state is far below this; it only bites if the one-time backlog
// prune hasn't run yet, in which case the cron self-drains the backlog over several days.
const MAX_ROWS_PER_RUN = 500_000;

export const loopHeartbeatsPrune = inngest.createFunction(
  {
    id: "loop-heartbeats-prune",
    retries: 1,
    triggers: [{ cron: "30 8 * * *" }], // Daily at 08:30 UTC (off-peak; before the 09:00 cron cluster)
  },
  async ({ step }) => {
    const result = await step.run("prune-old-beats", async () => {
      const admin = createAdminClient();
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

      let totalDeleted = 0;
      let batches = 0;
      while (totalDeleted < MAX_ROWS_PER_RUN) {
        const { data: rows, error: selErr } = await admin
          .from("loop_heartbeats")
          .select("id")
          .lt("ran_at", cutoff)
          .limit(BATCH_SIZE);

        if (selErr) {
          console.error("loop-heartbeats-prune select error:", selErr.message);
          break;
        }
        if (!rows?.length) break;

        const ids = rows.map((r) => r.id);
        const { error: delErr } = await admin.from("loop_heartbeats").delete().in("id", ids);
        if (delErr) {
          console.error("loop-heartbeats-prune delete error:", delErr.message);
          break;
        }

        totalDeleted += ids.length;
        batches++;
        if (ids.length < BATCH_SIZE) break; // drained
      }

      return { deleted: totalDeleted, batches, cutoff, capped: totalDeleted >= MAX_ROWS_PER_RUN };
    });

    console.log(
      `loop-heartbeats-prune: deleted ${result.deleted} beats in ${result.batches} batches (older than ${RETENTION_DAYS}d)`,
    );

    // Control Tower: end-of-run heartbeat so a dead pruner is visible (the table silently regrowing).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("loop-heartbeats-prune", { ok: true, produced: result });
    });

    return result;
  },
);
