---
name: probe-db
description: Use BEFORE assuming any schema, enum value, column shape, or row state in ShopCX — "the database is the spec." Read-only inspection of Supabase tables. Triggered whenever you're about to write code/SQL against a table and aren't 100% certain of its current shape, or need to confirm a status enum's actual lowercase values, whether a column exists, or what real data looks like.
---

# probe-db

Confirm reality before writing against it. Status enums, column shapes, and data states drift from docs — probe, don't assume.

## Procedure

1. **Write a throwaway script** `scripts/_probe-{topic}.ts` (the `_` prefix marks it disposable / not a tracked operational tool).
2. **Standard bootstrap** (every ShopCX script does this):
   ```ts
   import { readFileSync } from "fs";
   import { resolve } from "path";
   const envPath = resolve(__dirname, "../.env.local");
   for (const line of readFileSync(envPath, "utf8").split("\n")) {
     const t = line.trim(); if (!t || t.startsWith("#")) continue;
     const eq = t.indexOf("="); if (eq < 0) continue;
     const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
   }
   const { createAdminClient } = await import("../src/lib/supabase/admin");
   const admin = createAdminClient();
   ```
3. **Inspect read-only.** Sample rows, distinct enum values, null counts, column presence:
   ```ts
   const { data } = await admin.from("subscriptions").select("status").limit(2000);
   console.log([...new Set((data ?? []).map(r => r.status))]); // actual enum values
   ```
4. **Run it:** `npx tsx scripts/_probe-{topic}.ts`. Read the output. Delete or keep as `_`-prefixed.

## Guardrails

- **Read-only. No mutations, ever.** If you need to change data, that's a different skill (`backfill`, `write-migration`, `customer-remedy`).
- Status enums are **lowercase** — confirm the exact strings, don't guess casing.
- For raw SQL inspection (indexes, constraints, types) use a `pg.Client` against the pooler (`:6543`, `SUPABASE_DB_PASSWORD`) — same as `write-migration`.
- Prefer the brain `tables/{name}.md` page first; probe to confirm/extend it, then update the page if it drifted.

## Related
`docs/brain/tables/` · `docs/brain/README.md` (probing technique) · skills: `write-migration`, `verify-schema`
