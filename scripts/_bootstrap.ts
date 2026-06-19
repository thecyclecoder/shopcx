/**
 * Shared bootstrap for every `npx tsx scripts/*.ts` one-off.
 *
 * Replaces the ~150 hand-copied env-loader blocks. Import this FIRST and the
 * standard ShopCX script foundation is in place:
 *   - `.env.local` loaded into `process.env` (local dev only — see gotcha below)
 *   - `createAdminClient()` (service-role Supabase) ready to call
 *   - `pgClient()` / `poolerConnectionString()` for raw SQL against the pooler
 *
 * Usage (probe / data script):
 *   import { createAdminClient } from "./_bootstrap";
 *   const admin = createAdminClient();
 *
 * Usage (migration apply / raw SQL):
 *   import { pgClient } from "./_bootstrap";
 *   const c = pgClient(); await c.connect();
 *   try { await c.query(sql); } finally { await c.end(); }
 *
 * ⚠️ `.env.local` is ABSENT on the build box. The worker runs as `builder` with
 * no `.env.local` — secrets come from the systemd EnvironmentFile (process env).
 * `loadEnv()` is therefore existsSync-guarded: it loads the file when present and
 * is a no-op otherwise, so the same script works locally and on the box.
 *
 * Read-only by construction — this file performs no mutations. See the
 * `script-conventions`, `probe-db`, and `write-migration` skills.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";
import { createAdminClient as _createAdminClient } from "../src/lib/supabase/admin";

// Supabase project ref — same pooler identity every apply-script uses.
const PROJECT_REF = "urjbhjbygyxffrfkarqn";

let envLoaded = false;

/** Idempotently load `.env.local` into `process.env`. No-op when the file is absent (the build box). */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = resolve(__dirname, "../.env.local");
  if (!existsSync(envPath)) return; // box has none — secrets already in process.env
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

// Load on import so a bare `import "./_bootstrap"` is enough to wire up env.
loadEnv();

/** Service-role Supabase client. All script DB writes go through this (never client-side). */
export function createAdminClient() {
  loadEnv();
  return _createAdminClient();
}

/** Raw pooler connection string (`:6543`, transaction pooler, DB-password auth). */
export function poolerConnectionString(): string {
  loadEnv();
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    throw new Error(
      "SUPABASE_DB_PASSWORD is not set (and no SUPABASE_DB_URL/DATABASE_URL). " +
        "Locally: add it to .env.local. On the box: it comes from the systemd EnvironmentFile."
    );
  }
  const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
  return `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres`;
}

/** A `pg.Client` pointed at the pooler. Caller owns `connect()` / `end()`. */
export function pgClient(): Client {
  return new Client({ connectionString: poolerConnectionString() });
}
