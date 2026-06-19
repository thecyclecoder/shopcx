---
name: verify-schema
description: Use to assert that a table's live DB shape (columns, indexes, policies) matches what a brain page or migration claims in ShopCX — the genre of the scripts/_verify-*-schema.ts scripts. Read-only; prints the live columns/indexes/policies so you can eyeball them against the spec. Triggered after applying a migration to confirm it landed, or when a brain page's column list is suspected stale.
---

# verify-schema

A focused, read-only confirmation that a *specific* table is shaped the way the brain/migration says it is. Where [[probe-db]] is open-ended exploration ("what does this table look like?"), a `verify-schema` script is a committed, repeatable assertion for one table or feature — run it after a migration to prove the columns/indexes/policies actually landed, or against a brain page you suspect has drifted.

## Procedure

1. **Create** `scripts/_verify-{feature}-schema.ts`. `_`-prefixed (it's a checking tool, not a data artifact) and named for the feature, not one table, when a feature spans several (e.g. `_verify-prompt-learning-schema.ts` checks `sonnet_prompts` + `sonnet_prompt_decisions` + `workspaces`).
2. **Connect raw to the pooler.** These query `information_schema`/`pg_*`, so use a `pg.Client` on `:6543` with `SUPABASE_DB_PASSWORD` (the [[script-conventions]] bootstrap — `pgClient()`), not `createAdminClient()`.
3. **Assert the three things a migration touches:**
   - **columns** — `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$T ORDER BY ordinal_position` (narrow with a `column_name LIKE` / `IN (...)` when you only care about the new ones).
   - **indexes** — `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$T`.
   - **policies** — `SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=$T` (RLS is part of the spec — a table with no policies under RLS is a bug).
4. **Print, don't throw.** List the live columns/indexes/policies with counts; the human (or you) eyeballs them against the brain page / migration. Optionally hard-assert the must-exist names and `process.exit(1)` if missing — useful as a post-migration gate.
5. **Run:** `npx tsx scripts/_verify-{feature}-schema.ts` and diff the output against the [[write-migration|migration]] you just applied or the `docs/brain/tables/{table}.md` you're validating.

## Guardrails

- **Read-only, always.** `information_schema`/`pg_*` queries only — never `ALTER`/`INSERT`/`UPDATE`. This is a verifier, not a fixer; if it finds drift, the fix is a new migration ([[write-migration]]) or a brain regenerate ([[regenerate-brain]]), not an edit here.
- **The DB is the spec.** When the live shape and the brain disagree, the live DB wins — update the page (`_gen-brain-docs.ts` after a `_dump-schema.ts`), don't "fix" the DB to match stale prose.
- **No prod creds under the box worker.** It connects to the pooler, so request approval to run it (`{"type":"run_prod_script","cmd":"npx tsx scripts/_verify-{feature}-schema.ts"}`) and stop. Locally/interactively run it directly.
- **Pair it with the migration.** The natural moment to author a `_verify-*-schema.ts` is right after writing the migration — it becomes the "did it land?" check the owner runs post-apply.

## Related
`scripts/_verify-agent-todos-schema.ts` · `scripts/_verify-prompt-learning-schema.ts` · skills: `probe-db`, `write-migration`, `regenerate-brain`, `script-conventions` · `docs/brain/recipes/write-a-migration-apply-script.md`
