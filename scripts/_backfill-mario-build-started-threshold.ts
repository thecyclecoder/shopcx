/**
 * One-time backfill: seed the `build_started → build_done` row in
 * `public.mario_thresholds` for every workspace — the second Mario threshold
 * required by [[../docs/brain/specs/build-that-never-finishes-is-visible-to-mario]]
 * Phase 1.
 *
 * Why (spec's own summary, restated here so this script is self-documenting):
 * Mario's SLA table only carried the finish-side pair `build_done →
 * phase_shipped`, so a build that STARTS and never emits `build_done` fell
 * outside every threshold — the M3 detector's happy-path scan reads
 * thresholds generically already (`readThresholds` in
 * [[../src/lib/mario|src/lib/mario.ts]] issues one `listStalledCandidates`
 * scan per row), so seeding one more `(from_event, to_event)` pair brings the
 * previously-unwatched transition into the same reactive loop as every other
 * stall class. 2026-08-03 measurement: 432 specs sitting at `build_started`
 * with no follow-up `build_done`, 3 of them silent ~40 h (80× over the
 * finish-side SLA that could not see them). CEO surfaced them by hand because
 * no reactive agent was ever asked.
 *
 * SLA choice: 90 min (`5_400_000` ms). The worker's own `BUILD_HARD_CAP_MS`
 * is 60 min (`scripts/builder-worker.ts`) — a build that has emitted no
 * `build_done` at 60 min is definitionally dead — and
 * `MARIO_FAILED_BUILD_GRACE_MS` layers a 20-min recovery grace on top of the
 * failure signal, so 90 min sits comfortably past the tail of any legitimate
 * live build without racing the failed-build source (which fires at
 * `hard-cap + 20 min = 80 min` for a job the worker itself flipped to
 * `failed`). The three currently-stalled specs called out in the spec are
 * ~40 h silent — 80× over — so no plausibly tighter SLA is needed to catch
 * them; a wider one would still trip.
 *
 * Idempotent — the unique `(workspace_id, from_event, to_event)` constraint
 * on `public.mario_thresholds` means re-running finds the row already present
 * and this script exits clean (no version bump, no `sla_ms` overwrite of a
 * subsequent M4 self-tuner widening). The row is ALSO seeded by
 * `supabase/migrations/20261212120000_mario_threshold_build_started_build_done.sql`
 * — either surface applies the same `INSERT ... ON CONFLICT DO NOTHING`, and
 * this script is the tracked one the ship-time-backfill detector auto-
 * ledgers to `public.data_op_runs` (`_backfill-*.ts` filename convention);
 * it is a no-op once the migration has run.
 *
 * Auto-ledgered by the post-merge
 * [[../src/lib/ship-time-backfill-detector|ship-time-backfill-detector]]
 * because of the `scripts/_backfill-*.ts` filename convention, and drained
 * on the box by `executeShipTimeBackfillsForSpec` in
 * [[../src/lib/ship-time-backfill-executor|ship-time-backfill-executor]].
 *
 * Dry-run by default. Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-mario-build-started-threshold.ts            # dry-run
 *   npx tsx scripts/_backfill-mario-build-started-threshold.ts --apply    # write
 *
 * Spec: docs/brain/specs/build-that-never-finishes-is-visible-to-mario.md Phase 1.
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

const FROM_EVENT = "build_started";
const TO_EVENT = "build_done";
const SLA_MS = 5_400_000; // 90 min — past BUILD_HARD_CAP_MS + failed-build grace, never races the failed-build source
const MIN_COUNT = 1;

type WorkspaceRow = { id: string; name: string | null };

async function runOne(
  workspaceId: string,
): Promise<{ noop: boolean; reason: string }> {
  const admin = createAdminClient();

  const { data: existing, error: readErr } = await admin
    .from("mario_thresholds")
    .select("id, sla_ms")
    .eq("workspace_id", workspaceId)
    .eq("from_event", FROM_EVENT)
    .eq("to_event", TO_EVENT)
    .maybeSingle();
  if (readErr) throw new Error(`read failed: ${readErr.message}`);
  if (existing) {
    return {
      noop: true,
      reason: `${FROM_EVENT} → ${TO_EVENT} already present (sla_ms=${(existing as { sla_ms: number | string }).sla_ms})`,
    };
  }

  if (!APPLY) {
    return {
      noop: false,
      reason: `would insert ${FROM_EVENT} → ${TO_EVENT} (sla_ms=${SLA_MS}, min_count=${MIN_COUNT})`,
    };
  }

  const { error: insErr } = await admin
    .from("mario_thresholds")
    .upsert(
      {
        workspace_id: workspaceId,
        from_event: FROM_EVENT,
        to_event: TO_EVENT,
        sla_ms: SLA_MS,
        min_count: MIN_COUNT,
      },
      { onConflict: "workspace_id,from_event,to_event", ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  return {
    noop: false,
    reason: `inserted ${FROM_EVENT} → ${TO_EVENT} (sla_ms=${SLA_MS}, min_count=${MIN_COUNT})`,
  };
}

(async () => {
  const admin = createAdminClient();
  console.log(
    `mario_build_started_threshold_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  console.log(
    `  target: mario_thresholds row (${FROM_EVENT} → ${TO_EVENT}, sla_ms=${SLA_MS}, min_count=${MIN_COUNT})`,
  );
  console.log(
    "  scope:  every workspace's mario_thresholds (idempotent per workspace via the unique index)\n",
  );

  const { data: workspaces, error } = await admin
    .from("workspaces")
    .select("id, name")
    .order("id", { ascending: true });
  if (error) throw new Error(`workspaces read failed: ${error.message}`);
  const rows = (workspaces ?? []) as WorkspaceRow[];

  let scanned = 0;
  let noop = 0;
  let written = 0;
  let would = 0;
  let errored = 0;

  for (const w of rows) {
    scanned++;
    const label = `${w.name ?? "(unnamed)"} (${w.id})`;
    try {
      const res = await runOne(w.id);
      if (res.noop) {
        noop++;
        console.log(`  no-op    ${label} — ${res.reason}`);
      } else if (APPLY) {
        written++;
        console.log(`  written  ${label} — ${res.reason}`);
      } else {
        would++;
        console.log(`  would    ${label} — ${res.reason}`);
      }
    } catch (e) {
      errored++;
      console.error(
        `  ERROR    ${label} — ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  console.log("");
  if (APPLY) {
    console.log(
      `result: scanned=${scanned} no-op=${noop} written=${written} errored=${errored}`,
    );
  } else {
    console.log(
      `result: scanned=${scanned} no-op=${noop} would-write=${would} errored=${errored} ` +
        `(dry-run — re-run with --apply to write)`,
    );
  }
  if (errored > 0) process.exit(1);
})().catch(e => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
