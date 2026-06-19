---
name: script-conventions
description: Use when writing ANY new scripts/*.ts one-off in ShopCX (probe, migration apply, backfill, customer remedy, audit) — the shared foundation every script depends on. Triggered before authoring a script, or when a script fails on env/connection setup. Covers the scripts/_bootstrap.ts helper, the .env.local-absent-on-box gotcha, the _-prefix convention, and how scripts run.
---

# script-conventions

The shared foundation under every `scripts/*.ts`. Author new scripts on top of `scripts/_bootstrap.ts` instead of hand-copying the old env-loader block.

## How a script runs

- **Run with** `npx tsx scripts/<name>.ts`. There is no build step; `tsx` executes the TS directly.
- **`scripts/` is excluded from `tsc`** (`tsconfig.json` `exclude`), so a script's type errors do NOT show up in the `npx tsc --noEmit` build gate. Still keep them correct — they run for real.
- Scripts are CommonJS (no `"type": "module"` in `package.json`), so `__dirname` is available.

## The bootstrap (`scripts/_bootstrap.ts`)

Import it first; it loads env on import and exposes the standard helpers:

```ts
import { createAdminClient, pgClient, poolerConnectionString, loadEnv } from "./_bootstrap";

const admin = createAdminClient();              // service-role Supabase (all DB writes go through this)
// — or, for raw SQL against the pooler —
const c = pgClient();                           // pg.Client at :6543, DB-password auth
await c.connect();
try { /* c.query(...) */ } finally { await c.end(); }
```

- `loadEnv()` — idempotently loads `.env.local` into `process.env`; runs once on import.
- `createAdminClient()` — service-role client from `src/lib/supabase/admin.ts`.
- `pgClient()` / `poolerConnectionString()` — pooler (`:6543`, transaction pooler, `SUPABASE_DB_PASSWORD`).

## Guardrails

- **⚠️ `.env.local` is ABSENT on the build box.** The worker runs as `builder` with secrets injected via the systemd EnvironmentFile (process env), not a dotfile. `loadEnv()` is `existsSync`-guarded so it's a no-op there — never `readFileSync('.env.local')` unguarded (ENOENT crash before the script connects). The bootstrap already handles this; use it.
- **Pooler is `:6543`** (transaction pooler), auth is the **DB password** (`SUPABASE_DB_PASSWORD`), not the service-role JWT. Override host with `SUPABASE_DB_HOST` or the whole string with `SUPABASE_DB_URL` / `DATABASE_URL`.
- **`_`-prefix marks a throwaway** (probe / scratch): `scripts/_probe-*.ts`, `scripts/_check-*.ts`. An executed operational artifact (migration apply, customer remedy) is NOT prefixed — it stays for the audit trail.
- **All DB writes go through `createAdminClient()`** (service role) — never a client-side key. Internal joins use UUIDs, never `shopify_*_id`.
- Existing scripts still inline the old env-loader block; that's fine. New scripts should import `_bootstrap` — don't bulk-rewrite the back catalogue.

## Related
`scripts/_bootstrap.ts` · `src/lib/supabase/admin.ts` · skills: `probe-db`, `write-migration`, `customer-remedy`, `backfill` · spec `docs/brain/specs/repo-skills-catalog.md`
