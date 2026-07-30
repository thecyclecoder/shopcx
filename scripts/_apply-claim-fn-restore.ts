import { loadEnv } from "./_bootstrap"; loadEnv();
import { readFileSync } from "fs";
import { Client } from "pg";

// Restore public.claim_agent_job to its committed definition — the live function drifted to an old
// stripped version missing BOTH the (claimed_at is null or claimed_at <= now()) build-gate cooldown AND
// the kill-switch cascade, so #1923's verifier is holding the build lane closed. Applies the idempotent
// 20261014000000 migration. Uses a RAW pg.Client (NOT pgQuery, which swallows errors and returns null on
// throw) so any failure surfaces, and prefers the SESSION pooler (port 5432 — supports multi-statement
// DDL) over the transaction pooler (6543) that the app's pgQuery defaults to.

const PROJECT_REF = "urjbhjbygyxffrfkarqn"; // shopcx supabase project ref (matches src/lib/pg-pool.ts)
const DEFAULT_HOST = "aws-1-us-east-1.pooler.supabase.com"; // matches pg-pool.ts DEFAULT_HOST + migration-apply recipe

function connString(): string {
  let s = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
  if (!s) {
    const pw = process.env.SUPABASE_DB_PASSWORD;
    const host = process.env.SUPABASE_DB_HOST || DEFAULT_HOST;
    if (!pw) throw new Error("no SUPABASE_DB_URL / DATABASE_URL / SUPABASE_DB_PASSWORD in env");
    s = `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(pw)}@${host}:5432/postgres`;
  }
  // DDL needs the SESSION pooler (5432); the transaction pooler (6543) rejects multi-statement DDL.
  return s.replace(":6543/", ":5432/");
}

(async () => {
  const sql = readFileSync("supabase/migrations/20261014000000_kill_switch_enforce_claim.sql", "utf8");
  const cs = connString();
  console.log(`connecting via ${cs.replace(/:[^:@/]+@/, ":****@")}`);
  const client = new Client({ connectionString: cs, statement_timeout: 30000, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    console.log(`applying 20261014000000_kill_switch_enforce_claim.sql (${sql.length} chars)...`);
    await client.query(sql); // simple-query protocol: runs every statement in the file
    console.log("applied OK. re-probing live function...");
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_functiondef('public.claim_agent_job(text[])'::regprocedure) AS def`,
    );
    const def = rows?.[0]?.def ?? "";
    console.log("cooldown predicate present:", /claimed_at is null or claimed_at <= now\(\)/i.test(def));
    console.log("kill-switch enforcement present:", /node_ancestry|kill_switches/i.test(def));
    const t = await client.query<{ c: string }>(
      `SELECT count(*)::int c FROM information_schema.tables WHERE table_schema='public' AND table_name='node_ancestry'`,
    );
    console.log("node_ancestry table exists:", Number(t.rows?.[0]?.c ?? 0) > 0);
    const d = await client.query<{ c: string }>(`SELECT count(*)::int c FROM pg_proc WHERE proname='claim_agent_job_diag'`);
    console.log("claim_agent_job_diag exists:", Number(d.rows?.[0]?.c ?? 0) > 0);
  } finally {
    await client.end();
  }
})().then(() => process.exit(0)).catch((e) => {
  console.error("APPLY FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
