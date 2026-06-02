/**
 * Two-mode diagnostic on Supabase Postgres.
 *
 *   --activity         Snapshot of currently running queries (pg_stat_activity).
 *                      Wait events, query duration, locks. Best for "what is
 *                      pinning the DB right now."
 *
 *   --diff N           Take a pg_stat_statements snapshot, wait N seconds,
 *                      take another, and report what accumulated in that
 *                      window. Best for "what's actively pushing load."
 *                      Extrapolates to a 12h estimate at the end.
 *
 *   --info             Show pg_stat_statements_info — when stats were last
 *                      reset, so we know whether cumulative totals reflect
 *                      hours or weeks of activity.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const password = process.env.SUPABASE_DB_PASSWORD!;
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const PROJECT_REF = "urjbhjbygyxffrfkarqn";
const connectionString = `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres`;

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function showInfo() {
  await withClient(async (c) => {
    const { rows } = await c.query(`
      select
        stats_reset,
        extract(epoch from (now() - stats_reset))::int as seconds_since_reset
      from pg_stat_statements_info;
    `);
    console.log("pg_stat_statements_info:");
    console.log(rows[0]);
    const secs = rows[0].seconds_since_reset as number;
    console.log(`Stats span: ${(secs / 3600).toFixed(1)} hours (${(secs / 86400).toFixed(1)} days)`);
  });
}

async function showActivity() {
  await withClient(async (c) => {
    const { rows } = await c.query(`
      select
        pid,
        state,
        wait_event_type,
        wait_event,
        round(extract(epoch from (now() - query_start))::numeric, 1) as duration_sec,
        application_name,
        client_addr::text as client_addr,
        left(regexp_replace(query, '\\s+', ' ', 'g'), 220) as query_sample
      from pg_stat_activity
      where state != 'idle'
        and pid <> pg_backend_pid()
        and query is not null
      order by query_start asc nulls last
      limit 50;
    `);
    console.log(`Active / non-idle sessions: ${rows.length}\n`);
    for (const r of rows) {
      console.log(
        `pid=${r.pid} state=${r.state} wait=${r.wait_event_type}/${r.wait_event} dur=${r.duration_sec}s app=${r.application_name}`,
      );
      console.log(`  ${r.query_sample}`);
      console.log("");
    }

    // Blocked / blocking summary
    const { rows: locks } = await c.query(`
      select
        a.pid as blocked_pid,
        a.usename as blocked_user,
        a.query as blocked_query,
        b.pid as blocking_pid,
        b.query as blocking_query
      from pg_stat_activity a
      join pg_stat_activity b on b.pid = ANY(pg_blocking_pids(a.pid))
      where a.state != 'idle' and a.pid <> pg_backend_pid()
      limit 20;
    `);
    if (locks.length > 0) {
      console.log(`\n=== BLOCKED SESSIONS (${locks.length}) ===`);
      for (const r of locks) {
        console.log(`pid ${r.blocked_pid} is blocked by pid ${r.blocking_pid}`);
        console.log(`  blocked:  ${(r.blocked_query || "").slice(0, 180)}`);
        console.log(`  blocking: ${(r.blocking_query || "").slice(0, 180)}`);
        console.log("");
      }
    } else {
      console.log("\nNo blocked sessions.");
    }
  });
}

async function diffWindow(waitSec: number) {
  const sql = `
    select queryid, calls, total_exec_time, mean_exec_time, rows,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 240) as query_sample
    from pg_stat_statements
    where calls >= 1;
  `;
  console.log(`Taking snapshot 1…`);
  const snap1 = await withClient((c) => c.query(sql).then((r) => r.rows));
  const snap1Map = new Map(snap1.map((r) => [r.queryid, r]));
  console.log(`  ${snap1.length} statements tracked`);
  console.log(`Waiting ${waitSec}s…`);
  await new Promise((res) => setTimeout(res, waitSec * 1000));
  console.log(`Taking snapshot 2…`);
  const snap2 = await withClient((c) => c.query(sql).then((r) => r.rows));

  const diffs: Array<{
    queryid: string;
    calls: number;
    total_ms: number;
    mean_ms: number;
    rows: number;
    sample: string;
  }> = [];
  for (const r2 of snap2) {
    const r1 = snap1Map.get(r2.queryid);
    const callsDelta = r2.calls - (r1?.calls || 0);
    if (callsDelta <= 0) continue;
    const totalMs = r2.total_exec_time - (r1?.total_exec_time || 0);
    const rowsDelta = r2.rows - (r1?.rows || 0);
    diffs.push({
      queryid: r2.queryid,
      calls: callsDelta,
      total_ms: totalMs,
      mean_ms: totalMs / callsDelta,
      rows: rowsDelta,
      sample: r2.query_sample,
    });
  }
  diffs.sort((a, b) => b.total_ms - a.total_ms);

  console.log(`\n=== Top 25 by accumulated time in last ${waitSec}s ===\n`);
  const scaleTo12h = (43200 / waitSec);
  for (const d of diffs.slice(0, 25)) {
    const proj12h = (d.total_ms * scaleTo12h) / 1000;
    console.log(
      `[${d.calls.toString().padStart(7)} calls | mean ${d.mean_ms.toFixed(1).padStart(8)}ms | total ${(d.total_ms / 1000).toFixed(2).padStart(8)}s | proj 12h ${proj12h.toFixed(0).padStart(6)}s]`,
    );
    console.log(`  ${d.sample}`);
    console.log("");
  }
}

async function main() {
  if (process.argv.includes("--info")) return showInfo();
  if (process.argv.includes("--activity")) return showActivity();
  const diffArg = process.argv.find((a) => a.startsWith("--diff"));
  if (diffArg) {
    const next = process.argv[process.argv.indexOf(diffArg) + 1];
    const sec = Number(next) || 120;
    return diffWindow(sec);
  }
  console.error("Usage: --activity | --info | --diff <seconds>");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
