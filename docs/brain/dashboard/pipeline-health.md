# pipeline-health

Ada's Mario-supervisor telemetry surface — trigger-accuracy over the last N days + every widened `mario_thresholds` row Mario self-tuned (with a one-click **Revert**). Ships with mario-reactive-box-agent Phase 4. Route: `/dashboard/pipeline-health`. Segment layout wraps children in `<Suspense fallback={null}>` (Next 16 `cacheComponents` rule).

## Why

Mario is a broad-autonomy reactive agent — he applies non-destructive live fixes, authors durable fix-specs, and widens SLAs on false triggers. That autonomy is only safe when Ada can supervise it: what pct of Mario's fires were legitimate stalls (vs. false triggers he then widened the SLA for), and what widenings did he ship. This card is the **objective owner's read-through** (CEO → Ada → Mario, [[../operational-rules]] § North star).

## MarioAccuracyCard (the primary widget)

Reads via `GET /api/roadmap/mario/accuracy?workspace_id=…&window_days=7`. The API calls [[../libraries/mario]] `readMarioAccuracy` + `readMarioWidenedThresholds` + `readMarioAccuracyAlarmPct` and returns:

```ts
{
  stats: {
    window_days: number,
    fired_count: number,
    trigger_accurate_count: number,
    trigger_inaccurate_count: number,
    accuracy_pct: number | null   // null when no fires had a decided verdict yet
  },
  widened: MarioWidenedRow[],
  alarm_pct: number               // MARIO_ACCURACY_ALARM_PCT (default 60)
}
```

The card renders the **fired / accurate / accuracy_pct** triple + a table of widened rows. The accuracy pct turns red when it drops below `alarm_pct`; the same threshold is what the `mario-stall-cron`'s `accuracy-alarm` step compares against per tick.

The `readMarioAccuracy` query counts `director_activity` rows where `action_kind='mario_fired'` in the window and buckets by `metadata->>'trigger_accurate'` — the same shape Mario's `applyBoxMario` persists. SQL:

```sql
select
  count(*)                                                                  as fired_count,
  count(*) filter (where metadata->>'trigger_accurate' = 'true')            as trigger_accurate_count,
  count(*) filter (where metadata->>'trigger_accurate' = 'false')           as trigger_inaccurate_count
from public.director_activity
where action_kind = 'mario_fired'
  and workspace_id = $1
  and created_at > now() - interval '7 days';
```

`accuracy_pct` = `trigger_accurate_count / (trigger_accurate_count + trigger_inaccurate_count)` (rounded to 1 decimal). `null` when the denominator is zero.

## Widened-rows table + Revert

Every row in `mario_thresholds` where `last_widened_at IS NOT NULL` renders a row with:

- `from_event → to_event` (mono column, the SLA's key pair)
- Current `sla_ms` (formatted h/m/s)
- `last_widened_at` (localized short)
- `last_widened_reason` (Mario's plain-language why — the schema gate at [[../libraries/mario]] `applyBoxMario`'s threshold-self-tune step rejects an empty reason)
- **Revert** button → `POST /api/roadmap/mario/threshold/revert`

Revert falls back to the seeded default when the caller doesn't pass `pre_widen_sla_ms` — the `MARIO_SEEDED_DEFAULT_SLA_MS` map in [[../libraries/mario]] mirrors the values in `supabase/migrations/20261004120000_mario_thresholds.sql`. On success: `sla_ms` returns to the pre-widen value, `last_widened_at + last_widened_reason` are cleared, and a `mario_threshold_reverted` director_activity row is written (actor is the caller's display_name).

## Accuracy alarm (surfaced from the cron)

The `mario-stall-cron` runs an `accuracy-alarm` step per tick. Per workspace, it reads `readMarioAccuracy(admin, ws, 1)` and — when `fired_count ≥ 5` AND `accuracy_pct !== null` AND `accuracy_pct < MARIO_ACCURACY_ALARM_PCT` (default 60) — inserts ONE OPEN `dashboard_notifications` row (`type='mario_accuracy_alarm'`, `metadata.target='platform'`) deduped on `metadata.dedupe_key='mario_accuracy_alarm:<workspace>'` so a stretch of red ticks doesn't stack notifications.

The card is Ada's continuous read; the alarm is the one that pages her when she isn't looking.

## Env

| Env | Default | What it does |
|---|---|---|
| `MARIO_AUTONOMY_MODE` | `live` | `live` (act), `surface_only` (log + escalate, no mutation), `off` (guarded upstream). |
| `MARIO_LOOP_GUARD_MAX` | `3` | Prior-24h `mario_fixed` count above which a live fix is skipped + `mario_loop_guard` recorded. |
| `MARIO_ACCURACY_ALARM_PCT` | `60` | Under this pct, the accuracy alarm surfaces to Ada / CEO. |

## Related

- [[../libraries/mario]] — the M3 SDK + M4 mutator (`applyBoxMario`), the accuracy readers (`readMarioAccuracy`, `readMarioWidenedThresholds`), the revert (`revertMarioThreshold`), and the alarm-pct reader (`readMarioAccuracyAlarmPct`).
- [[../functions/platform]] — Ada supervises Mario; this card is her lens on his supervisability.
- [[../inngest/mario-stall-cron]] — the cron that spawns Mario and (Phase 4) runs the `accuracy-alarm` step.
- [[../tables/mario_thresholds]] — the widened rows' source of truth.
- [[../tables/director_activity]] — the `mario_fired` / `mario_fixed` / `mario_loop_guard` / `mario_threshold_reverted` ledger the accuracy query reads.
- [[../../.claude/skills/mario/SKILL.md]] — Mario's read-only investigation contract + JSON verdict envelope.
