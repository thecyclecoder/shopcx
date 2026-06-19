---
name: regenerate-brain
description: Use to refresh the auto-generated parts of docs/brain/ from the live code + schema in ShopCX — the four scripts/_gen-brain-*.ts generators (tables, inngest, libraries, dashboard) plus the brain:index reconcile. Triggered after a schema change lands, after adding/renaming src/lib/* or src/lib/inngest/* files or dashboard pages, or when a brain page's auto sections (columns/FKs/exports/triggers) drift from reality.
---

# regenerate-brain

The brain's per-page facts are part hand-curated, part machine-generated. Four `scripts/_gen-brain-*.ts` generators rebuild the **auto** sections (columns/FKs/indexes, inngest triggers/events, library exports/signatures, dashboard routes) from the live code + schema; the curated `SUMMARIES`/`PURPOSE` maps inside each generator stay hand-written. Run them so the auto half never lies — then reconcile the two index files.

## The four generators (+ their inputs)

| Script | Regenerates | Reads from |
|---|---|---|
| `_gen-brain-docs.ts` | `docs/brain/tables/*.md` | `tmp-schema.json` (must dump first — see below) |
| `_gen-brain-inngest.ts` | `docs/brain/inngest/*.md` | `src/lib/inngest/*.ts` |
| `_gen-brain-libraries.ts` | `docs/brain/libraries/*.md` | `src/lib/*.ts` (skips `inngest/`) |
| `_gen-brain-dashboard.ts` | `docs/brain/dashboard/*.md` | `src/app/dashboard/**/page.tsx` |

## Procedure

1. **Tables only — dump the schema first.** `_gen-brain-docs.ts` reads `tmp-schema.json`, it does **not** hit the DB itself. Run `npx tsx scripts/_dump-schema.ts` (connects to the pooler, needs `SUPABASE_DB_PASSWORD`) to refresh `tmp-schema.json`, then `npx tsx scripts/_gen-brain-docs.ts`. The other three read source files directly — no dump needed.
2. **Run only the generators whose inputs changed.** Schema change → dump + `_gen-brain-docs`. New/renamed `src/lib/inngest/*` → `_gen-brain-inngest`. New/renamed `src/lib/*` → `_gen-brain-libraries`. New dashboard route → `_gen-brain-dashboard`. Running all four is harmless but the diff is noisier.
3. **Curate the description before generating.** A brand-new table/file gets a generic auto page unless you add its one-liner to the generator's curated map (`SUMMARIES` in docs/inngest/libraries, `PURPOSE` in dashboard). Edit the map in the generator, *then* run it — the curated text is baked into the output.
4. **Reconcile the index files.** `node scripts/brain-index.mjs` (a.k.a. `npm run brain:index`) rebuilds `docs/brain/archive.md` "## Index" and the README folder counts from the actual file set. Pure Node ESM, no DB — always safe to run last.
5. **Review the diff, then commit.** `git diff docs/brain/` — the auto sections should change, the curated prose should not (unless you edited a map). Commit the regenerated pages in the same change as the code/schema that moved them.

## Guardrails

- **`_gen-brain-docs.ts` is stale without a fresh dump.** It silently regenerates from whatever `tmp-schema.json` already holds. Always `_dump-schema.ts` first or you'll "regenerate" yesterday's columns. (`tmp-schema.json` is a throwaway — don't commit it.)
- **Don't hand-edit the auto sections.** They get overwritten on the next run. Put corrections in the generator's curated map or the page's curated zones.
- **Generators read code, not prod — but `_dump-schema.ts` hits the pooler.** Under the box worker you have no prod creds: the three source-reading generators (`inngest`/`libraries`/`dashboard`) + `brain-index.mjs` run fine, but refreshing tables needs `_dump-schema.ts` against prod → request approval (`{"type":"run_prod_script","cmd":"npx tsx scripts/_dump-schema.ts"}`) and stop. Locally/interactively run it directly.
- **`_`-prefixed = throwaway-by-convention but these stay** — they're the committed generators, not one-off probes. Don't delete them after running.

## Related
`scripts/_gen-brain-docs.ts` · `scripts/_gen-brain-inngest.ts` · `scripts/_gen-brain-libraries.ts` · `scripts/_gen-brain-dashboard.ts` · `scripts/_dump-schema.ts` · `scripts/brain-index.mjs` · skills: `write-brain-page`, `fold-to-brain`, `probe-db` · `docs/brain/README.md`
