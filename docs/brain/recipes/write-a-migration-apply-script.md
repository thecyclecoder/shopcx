# Write a migration-apply script

Pattern for `scripts/apply-{migration-name}.ts` — runs a single SQL migration against the Supabase Postgres pooler. Used when you don't want to wait for the Supabase migration runner OR when the migration touches data that can't be staged via the dashboard.

## Template

```ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

// Load .env.local (scripts/ doesn't auto-load like Next.js)
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
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

const sql = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260602250000_my_migration.sql"),
  "utf8"
);

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    await c.query(sql);
    console.log("✓ applied");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Run with: `npx tsx scripts/apply-my-migration.ts`.

## Required env

- `SUPABASE_DB_PASSWORD` — the Postgres direct connection password (NOT the service role JWT).
- Optional: `SUPABASE_DB_HOST` for non-default region (default `aws-1-us-east-1.pooler.supabase.com`).

The project ref (`urjbhjbygyxffrfkarqn`) is hardcoded in our scripts — it's our Supabase project.

## When to use a migration runner vs an apply script

Use a **migration file + standard Supabase migration runner** when:

- The change is pure DDL (new table, new column, new index).
- You can wait for the next deploy cycle.

Use an **apply script** when:

- You need to run BEFORE the deploy so the new code doesn't 500.
- The migration also requires a backfill that's too big for a single transaction.
- You want to test the migration against production state before adding it to the standard migrations folder.

## Backfill apply scripts

For data backfills, the pattern is the same but with progress logging:

```ts
async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    const { rows } = await c.query("SELECT id FROM orders WHERE foo IS NULL");
    console.log(`Backfilling ${rows.length} orders…`);
    let done = 0;
    for (const row of rows) {
      await c.query("UPDATE orders SET foo = $1 WHERE id = $2", [computed, row.id]);
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${rows.length}`);
    }
    console.log(`✓ ${done}/${rows.length}`);
  } finally {
    await c.end();
  }
}
```

## Gotchas

- **Pooler port is 6543**, not 5432. The pooler accepts more concurrent connections and is faster for short-lived scripts.
- **Single SQL string** — multi-statement files are fine, but they run in one implicit transaction. Use explicit `BEGIN; ... COMMIT;` for safety on backfills.
- **Don't `git add` .env.local**.
- **Service role doesn't work here.** This is direct Postgres auth, not Supabase API. Use the DB password.
- **For idempotent scripts**, prefer `INSERT … ON CONFLICT DO NOTHING` or `UPDATE … WHERE foo IS NULL` patterns so re-runs are safe.
- **Connection limit.** Don't open multiple clients — one per script.
- **After apply**: drop the file into `supabase/migrations/` if you want it in the migration history, or delete the apply script if it was a one-off backfill.

## Related

[[fire-an-inngest-event]] · [[../tables/sync_jobs]] · [[../tables/import_jobs]]
