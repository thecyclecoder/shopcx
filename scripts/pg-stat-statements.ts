/**
 * Run pg_stat_statements via the Supabase transaction pooler to find
 * the slowest queries. Read-only — purely diagnostic.
 *
 * Loads SUPABASE_DB_PASSWORD from .env.local. Project ref is
 * hardcoded from CLAUDE.md.
 *
 * Usage: npx tsx scripts/pg-stat-statements.ts [--mean | --total | --calls]
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

const password = process.env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error("SUPABASE_DB_PASSWORD not set");
  process.exit(1);
}

const PROJECT_REF = "urjbhjbygyxffrfkarqn";
// Override via SUPABASE_DB_HOST env if region differs. Try transaction
// pooler in common regions; the direct host (db.{ref}.supabase.co) is
// IPv6-only on newer projects so fallback isn't always reachable.
const host = process.env.SUPABASE_DB_HOST || "aws-0-us-east-2.pooler.supabase.com";
const connectionString = `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres`;

const orderBy = process.argv.includes("--total")
  ? "total_exec_time"
  : process.argv.includes("--calls")
    ? "calls"
    : "mean_exec_time";

async function main() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const sql = `
      select
        queryid,
        calls,
        round(mean_exec_time::numeric, 2) as mean_ms,
        round(total_exec_time::numeric / 1000, 2) as total_sec,
        rows,
        left(regexp_replace(query, '\\s+', ' ', 'g'), 220) as query_sample
      from pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())
        and calls >= 5
      order by ${orderBy} desc
      limit 25;
    `;
    const { rows } = await client.query(sql);
    console.log(`Top 25 by ${orderBy}\n`);
    for (const r of rows) {
      console.log(
        `[${r.calls.toString().padStart(7)} calls | mean ${String(r.mean_ms).padStart(8)}ms | total ${String(r.total_sec).padStart(8)}s | rows ${String(r.rows).padStart(8)}]`,
      );
      console.log(`  ${r.query_sample}`);
      console.log("");
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
