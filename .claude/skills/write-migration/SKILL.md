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
   import { readFileSync } from "fs";
   import { resolve } from "path";
   import { Client } from "pg";
   const envPath = resolve(__dirname, "../.env.local");
   for (const line of readFileSync(envPath, "utf8").split("\n")) {
     const t = line.trim(); if (!t || t.startsWith("#")) continue;
     const eq = t.indexOf("="); if (eq < 0) continue;
     const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
   }
   const password = process.env.SUPABASE_DB_PASSWORD!;
   const cs = `postgres://postgres.<project-ref>:${encodeURIComponent(password)}@<region>.pooler.supabase.com:6543/postgres`;
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

- **Pooler port is `6543`** (transaction pooler), not 5432. Auth is the **DB password** (`SUPABASE_DB_PASSWORD`), not the service-role JWT.
- **For backfills**, wrap in explicit `BEGIN`/`COMMIT` and prefer `UPDATE … WHERE col IS NULL` / `INSERT … ON CONFLICT` so partial re-runs are safe.
- **Never run during active Inngest syncs** — a long migration blocks writes and the deploy can kill running functions.
- One `pg.Client` per script; always `await c.end()` in `finally`.
- Add RLS policies for any new table (`{table}_select` for members, `{table}_service` for service role).

## Related
`docs/brain/recipes/write-a-migration-apply-script.md` · `supabase/migrations/` · skills: `probe-db`, `backfill`, `verify-schema`
