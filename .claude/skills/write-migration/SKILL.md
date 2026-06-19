---
name: write-migration
description: Use when adding or altering a Postgres table, column, index, enum, or RLS policy in ShopCX, or running a large data backfill in SQL. Authors a supabase/migrations/*.sql file and a matching apply-script that runs it against the Supabase pooler. Triggered by schema changes a build needs, or "apply this migration to prod."
---

# write-migration

Author a migration + the script that applies it. ShopCX applies migrations via standalone scripts (not the Supabase CLI runner) so they can run against the pooler with the DB password.

## Procedure

1. **Write the migration SQL** at `supabase/migrations/YYYYMMDDNNNNNN_description.sql`. Timestamp prefix orders application; later files may depend on earlier ones.
2. **Make it idempotent** — `create table if not exists`, `add column if not exists`, `create index if not exists`, `insert … on conflict do nothing`. Re-running must be safe.
3. **Write the apply-script** `scripts/apply-{name}-migration.ts`:
   ```ts
   import { readFileSync, existsSync } from "fs";
   import { resolve } from "path";
   import { Client } from "pg";
   // Load .env.local IF present (local dev). On the BUILD BOX there is NONE — secrets come from the
   // process env (systemd EnvironmentFile). GUARD the read with existsSync, or the apply crashes
   // with ENOENT before it connects and the migration silently "fails" through the approval gate.
   const envPath = resolve(__dirname, "../.env.local");
   if (existsSync(envPath)) {
     for (const line of readFileSync(envPath, "utf8").split("\n")) {
       const t = line.trim(); if (!t || t.startsWith("#")) continue;
       const eq = t.indexOf("="); if (eq < 0) continue;
       const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
     }
   }
   const password = process.env.SUPABASE_DB_PASSWORD;
   const cs =
     process.env.SUPABASE_DB_URL ||
     process.env.DATABASE_URL ||
     `postgres://postgres.<project-ref>:${encodeURIComponent(password!)}@<region>.pooler.supabase.com:6543/postgres`;
   const MIGRATIONS = ["YYYYMMDDNNNNNN_description.sql"]; // in order
   const c = new Client({ connectionString: cs });
   await c.connect();
   try {
     for (const f of MIGRATIONS) {
       await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", f), "utf8"));
       console.log(`✓ applied ${f}`);
     }
   } finally { await c.end(); }
   ```
   (Copy the exact connection string from any existing `scripts/apply-*-migration.ts` — same pooler host/ref.)
4. **Run it:** `npx tsx scripts/apply-{name}-migration.ts`.
5. **Brain page.** A new table needs `docs/brain/tables/{name}.md` (columns, FKs, gotchas) in the same change — code without a brain page is incomplete.

## Guardrails

- **⚠️ `.env.local` is ABSENT on the build box.** The worker runs as `builder` from `/home/builder/shopcx` with **no `.env.local`** — `SUPABASE_DB_PASSWORD` is injected into the process env via the systemd EnvironmentFile. So **always guard the `.env.local` read with `existsSync`** and rely on `process.env`. An unguarded `readFileSync('.env.local')` throws ENOENT and the migration silently fails through the approval gate (the #1 cause of a "needs_approval that won't clear").
- **Probe before requesting approval (stop the re-request loop).** Under the box worker, applying is a gated `needs_approval` step. Before requesting it — especially on a **resume**, where the migration may already have been applied on a prior round — use `probe-db` to check whether the change already exists (table/column/index/enum present). If it's already there, **skip the approval request** and keep building. The apply-script is idempotent, so this only removes a needless pause; it never skips a genuinely-new change. Also honour any `Already-applied gated actions … do NOT re-request` note in a resume prompt.
- **Pooler port is `6543`** (transaction pooler), not 5432. Auth is the **DB password** (`SUPABASE_DB_PASSWORD`), not the service-role JWT.
- **For backfills**, wrap in explicit `BEGIN`/`COMMIT` and prefer `UPDATE … WHERE col IS NULL` / `INSERT … ON CONFLICT` so partial re-runs are safe.
- **Never run during active Inngest syncs** — a long migration blocks writes and the deploy can kill running functions.
- One `pg.Client` per script; always `await c.end()` in `finally`.
- Add RLS policies for any new table (`{table}_select` for members, `{table}_service` for service role).

## Related
`docs/brain/recipes/write-a-migration-apply-script.md` · `supabase/migrations/` · skills: `probe-db`, `backfill`, `verify-schema`
