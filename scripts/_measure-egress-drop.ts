/**
 * _measure-egress-drop — the Phase-4 measurement tool for
 * docs/brain/specs/cut-internal-egress-pooler-and-spec-rpcs.md.
 *
 * READ-ONLY inspection of pg_stat_statements + pg_stat_statements_info to confirm the drop that
 * Phases 1-3 target:
 *   - Phase 1 (pg-pool): the box poll loop's hot reads no longer show as PostgREST calls
 *     (set_config preamble share + the agent_jobs existence read + queued-kind DISTINCT).
 *   - Phase 2 (get_spec_with_phases): specs + spec_phases per-call rate collapses into the
 *     get_spec_with_phases RPC (one round trip instead of two per getSpec).
 *   - Phase 3 (control_tower_snapshot + visibility gating): the Control Tower panel reads
 *     collapse into control_tower_snapshot; a backgrounded tab issues no polls.
 *
 * Mirrors the exact aggregate `analyzeRequestVolume` uses (src/lib/control-tower/db-health.ts),
 * so a measurement here is directly comparable to Devi's `request_volume_pressure` finding on the
 * DB_HEALTH_SLOWQ_LOOP_ID beat. Prints the current rates + the baseline recorded in the spec so
 * the drop is visible at a glance.
 *
 * Read-only by construction (SELECT-only against pg_stat_statements + friends). Follows the
 * script-conventions skill — bootstrap via `./_bootstrap` + a pooler `pgClient()`.
 *
 * Run (locally or on the box):
 *   npx tsx scripts/_measure-egress-drop.ts
 *
 * Optional: reset pg_stat_statements first (requires superuser) so the window starts fresh
 * post-deploy. This script does NOT reset — that's a deliberate act, not a measurement.
 */
import { pgClient } from "./_bootstrap";

// ── Baseline from the spec header (docs/brain/specs/cut-internal-egress-pooler-and-spec-rpcs.md) ──
// These are what Devi's request_volume_pressure finding reported BEFORE Phases 1-3 shipped. Recorded
// so a post-deploy measurement is a delta, not an absolute reading in isolation.
const BASELINE_REQ_PER_HR = 200_000;
const BASELINE_ROWS_PER_HR = 182_000;
const BASELINE_SPECS_CALLS_PER_HR = 50_000;
const BASELINE_SPEC_PHASES_CALLS_PER_HR = 44_000;
const BASELINE_SET_CONFIG_SHARE = 0.45;

// The flags analyzeRequestVolume uses to fire request_volume_pressure — the same thresholds so a
// measurement here says whether the escalation would still fire on the current window.
const REQUEST_VOLUME_CALLS_PER_HR_FLAG = 100_000;
const REQUEST_VOLUME_ROWS_PER_HR_FLAG = 100_000;

// The set-of-strings that identify the PostgREST auth preamble (mirrors isInfrastructuralQuery's
// intent — a set_config('role' | 'search_path' | 'request.*' | 'request.jwt.*') at statement start).
// Kept as a SQL LIKE ORed set so a plain pg query is enough — no in-JS regex.
const SET_CONFIG_LIKES = [
  `%set_config('role'%`,
  `%set_config('search_path'%`,
  `%set_config('request.%`,
  `%set_config('request.jwt%`,
  `%SELECT set_config($%`,
];

interface Totals { calls: number; rows: number }
interface TopRow  { queryid: string; query: string; calls: number; rows: number }

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    // Window since the last reset.
    const infoRes = await c.query<{ stats_reset: string | null }>(
      `select stats_reset from pg_stat_statements_info`,
    );
    const statsReset = infoRes.rows[0]?.stats_reset ?? null;
    const windowHours = statsReset ? Math.max(0, (Date.now() - new Date(statsReset).getTime()) / 3_600_000) : 0;

    // Aggregate totals (same shape analyzeRequestVolume reads).
    const totalsRes = await c.query<{ calls: string; rows: string }>(
      `select coalesce(sum(calls),0)::bigint as calls,
              coalesce(sum(rows),0)::bigint as rows
         from pg_stat_statements`,
    );
    const totals: Totals = {
      calls: Number(totalsRes.rows[0]?.calls ?? 0),
      rows:  Number(totalsRes.rows[0]?.rows  ?? 0),
    };

    // Set_config preamble share (Phase-1 tell).
    const setConfigCallsRes = await c.query<{ calls: string }>(
      `select coalesce(sum(calls),0)::bigint as calls
         from pg_stat_statements
        where ${SET_CONFIG_LIKES.map((_, i) => `query like $${i + 1}`).join(" or ")}`,
      SET_CONFIG_LIKES,
    );
    const setConfigCalls = Number(setConfigCallsRes.rows[0]?.calls ?? 0);

    // Per-table call-rate slices (Phases 2 + 1 tells). We probe the raw table names on top-level
    // reads — a normalized query text carries the table name verbatim.
    const perTable = async (like: string): Promise<{ calls: number; rows: number }> => {
      const r = await c.query<{ calls: string; rows: string }>(
        `select coalesce(sum(calls),0)::bigint as calls,
                coalesce(sum(rows),0)::bigint as rows
           from pg_stat_statements
          where query ilike $1`,
        [like],
      );
      return { calls: Number(r.rows[0]?.calls ?? 0), rows: Number(r.rows[0]?.rows ?? 0) };
    };
    const specsSlice        = await perTable(`% from "public"."specs" %`);
    const specPhasesSlice   = await perTable(`% from "public"."spec_phases" %`);
    const agentJobsSlice    = await perTable(`% from "public"."agent_jobs" %`);
    const claudeHealthSlice = await perTable(`% from "public"."claude_health" %`);

    // The Phase-2/3 RPC call rates (should be non-zero once they're driving traffic).
    const rpcSlice = async (name: string): Promise<{ calls: number; rows: number }> => {
      const r = await c.query<{ calls: string; rows: string }>(
        `select coalesce(sum(calls),0)::bigint as calls,
                coalesce(sum(rows),0)::bigint as rows
           from pg_stat_statements
          where query ilike $1`,
        [`%${name}%`],
      );
      return { calls: Number(r.rows[0]?.calls ?? 0), rows: Number(r.rows[0]?.rows ?? 0) };
    };
    const getSpecRpc        = await rpcSlice(`get_spec_with_phases`);
    const listSpecsRpc      = await rpcSlice(`list_specs_with_phases`);
    const ctSnapshotRpc     = await rpcSlice(`control_tower_snapshot`);

    // Top callers (parity with analyzeRequestVolume's top-8 lists).
    const topByCalls = await c.query<TopRow>(
      `select queryid::text as queryid, query, calls, rows
         from pg_stat_statements
        order by calls desc
        limit 8`,
    );
    const topByRows = await c.query<TopRow>(
      `select queryid::text as queryid, query, calls, rows
         from pg_stat_statements
        order by rows desc
        limit 8`,
    );

    // ── Format ────────────────────────────────────────────────────────────────
    const perHr = (n: number) => (windowHours > 0 ? Math.round(n / windowHours) : 0);
    const fmt = (n: number) => Math.round(n).toLocaleString();
    const pct = (frac: number) => `${(frac * 100).toFixed(1)}%`;
    const arrow = (curr: number, base: number) => {
      if (base <= 0) return "";
      const delta = (curr - base) / base;
      const dir = delta < 0 ? "▼" : "▲";
      return ` (${dir} ${pct(Math.abs(delta))} vs baseline ${fmt(base)})`;
    };

    const callsPerHr = perHr(totals.calls);
    const rowsPerHr = perHr(totals.rows);
    const setConfigShare = totals.calls > 0 ? setConfigCalls / totals.calls : 0;
    const specsCallsPerHr = perHr(specsSlice.calls);
    const specPhasesCallsPerHr = perHr(specPhasesSlice.calls);

    console.log(`
cut-internal-egress-pooler-and-spec-rpcs — Phase 4 measurement
==============================================================

Window: ${windowHours.toFixed(1)}h since pg_stat_statements last reset${statsReset ? ` (${statsReset})` : ""}.

Aggregate (same aggregate Devi's request_volume_pressure detector reads)
------------------------------------------------------------------------
  Total statements:  ${fmt(totals.calls)} → ${fmt(callsPerHr)}/hr${arrow(callsPerHr, BASELINE_REQ_PER_HR)}
  Total rows shipped: ${fmt(totals.rows)} → ${fmt(rowsPerHr)}/hr${arrow(rowsPerHr, BASELINE_ROWS_PER_HR)}

  request_volume_pressure flag thresholds:
    calls/hr flag:  ${fmt(REQUEST_VOLUME_CALLS_PER_HR_FLAG)} — currently ${callsPerHr >= REQUEST_VOLUME_CALLS_PER_HR_FLAG ? "OVER" : "under"}
    rows/hr flag:   ${fmt(REQUEST_VOLUME_ROWS_PER_HR_FLAG)} — currently ${rowsPerHr >= REQUEST_VOLUME_ROWS_PER_HR_FLAG ? "OVER" : "under"}
    → request_volume_pressure ${callsPerHr >= REQUEST_VOLUME_CALLS_PER_HR_FLAG || rowsPerHr >= REQUEST_VOLUME_ROWS_PER_HR_FLAG ? "WOULD FIRE" : "would NOT fire"} on this window

Phase-1 tells (box poll loop → persistent pooler pool)
------------------------------------------------------
  set_config preamble share: ${pct(setConfigShare)} of all calls${arrow(setConfigShare, BASELINE_SET_CONFIG_SHARE)}
    (baseline was ~${pct(BASELINE_SET_CONFIG_SHARE)}; Phase 1 moves the top hot reads off PostgREST → pooled pg)
  agent_jobs table calls: ${fmt(perHr(agentJobsSlice.calls))}/hr

Phase-2 tells (get_spec_with_phases RPC)
----------------------------------------
  specs table calls:       ${fmt(specsCallsPerHr)}/hr${arrow(specsCallsPerHr, BASELINE_SPECS_CALLS_PER_HR)}
  spec_phases table calls: ${fmt(specPhasesCallsPerHr)}/hr${arrow(specPhasesCallsPerHr, BASELINE_SPEC_PHASES_CALLS_PER_HR)}
  get_spec_with_phases RPC calls:  ${fmt(perHr(getSpecRpc.calls))}/hr  (Phase 2)
  list_specs_with_phases RPC calls: ${fmt(perHr(listSpecsRpc.calls))}/hr  (pre-existing, prior spec)

Phase-3 tells (control_tower_snapshot + visibility gating)
----------------------------------------------------------
  control_tower_snapshot RPC calls: ${fmt(perHr(ctSnapshotRpc.calls))}/hr  (was 0 pre-Phase-3)
  claude_health table calls:        ${fmt(perHr(claudeHealthSlice.calls))}/hr  (now inside the snapshot RPC)

Top callers by request count (parity with analyzeRequestVolume's top-8):
`);
    for (const r of topByCalls.rows) {
      const share = totals.calls > 0 ? pct(r.calls / totals.calls) : "0%";
      console.log(`  - ${fmt(r.calls)} calls (${share}) — ${r.query.replace(/\s+/g, " ").slice(0, 140)}`);
    }
    console.log(`
Top callers by rows shipped (egress):
`);
    for (const r of topByRows.rows) {
      const share = totals.rows > 0 ? pct(r.rows / totals.rows) : "0%";
      console.log(`  - ${fmt(r.rows)} rows over ${fmt(r.calls)} calls (${share}) — ${r.query.replace(/\s+/g, " ").slice(0, 140)}`);
    }

    console.log(`
Interpretation
--------------
- A CLEAR DROP in calls/hr + rows/hr AND set_config share is the Phase-1 win (hot poll-loop reads
  moved off PostgREST onto the pooled pg path — no more per-request set_config preamble on those).
- A CLEAR DROP in specs + spec_phases per-call rate is the Phase-2 win — getSpec now issues one
  get_spec_with_phases RPC instead of two .from() reads.
- A non-zero control_tower_snapshot call rate + a corresponding drop in the six individual panel
  reads (claude_health / spec_drift / director_activity / db_table_size_history / loop_heartbeats
  / agent_jobs kind=repair|db_health|coverage-register) is the Phase-3 win.
- If request_volume_pressure "would NOT fire on this window", Devi's DB_HEALTH_SLOWQ_LOOP_ID beat
  should stop proposing the reduce_calls escalation.
- Residual top callers here are the follow-up levers.
`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
