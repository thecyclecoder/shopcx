# Storefront lever-importance memory — restore persist path + rebaseline verification

**Owner:** [[../functions/platform]] · **Parent:** M2 — Lever-importance model + CRO-learnings memory ([[../goals/storefront-optimizer]])
**Fixes:** storefront-lever-importance-memory (check 3143de706a5d0396, 83269bdebbc903d0, 88dc21304e9336f6, 8598fc9e64845434)
**Supersedes:** [[storefront-lever-importance-restore-seeded-from-column]]

Restore the M2 [[storefront-lever-importance-memory|lever-importance memory]]'s posterior persist path and re-baseline its verification so the storefront-optimizer's brain compounds learnings again. The live `storefront_lever_importance` table is missing the `seeded_from` column the migration file declares — `lever-memory.ts:301-314` INSERTs it on every new cell, PostgREST returns 42703, [[../libraries/storefront-experiment-refresh|experiment-refresh]] silently catches the failure, and the funnel-dashboard "What the agent believes matters" panel stays hidden behind a length-guard. Two of the original spec's verification checks also pin numeric prior values that legitimately drift (funnel-data seeding is a designed Phase 1 feature) and the panel check is chicken-and-egg with the persist path. This fix ships the additive ALTER, loosens the over-pinned numerics to shape-assertions, and gives the panel an empty-state so the verification can pass on a clean DB. Business outcome: every concluded M1 experiment commits a learning, the agent stops re-testing levers it already knows about, and the founder sees the brain forming on the funnel dashboard.

## Phase 1 — schema restore (additive ALTER)

Ship `supabase/migrations/20260712120000_storefront_lever_importance_seeded_from.sql` (already authored on this branch as part of the superseded spec) — `alter table public.storefront_lever_importance add column if not exists seeded_from text not null default 'cro_prior';` plus a defensive `update … set seeded_from = 'cro_prior' where seeded_from is null;`. Keep `scripts/apply-storefront-lever-memory-migration.ts` with both migrations in its `MIGRATIONS` array so the same verification script applies both. Idempotent + safe to re-run. No `src/` change required — [[../libraries/storefront-lever-memory|lever-memory.ts]] already INSERTs the column.

## Phase 2 — rebaseline the original spec's verification

Edit `docs/brain/specs/storefront-lever-importance-memory.md` (the shipped spec) so its `## Verification` checklist asserts SHAPE rather than literal numbers that legitimately drift. Change:

- `15 columns` stays (post Phase 1 the count is stable); drop `22 levers` and assert `≥ 25 levers` (the 9 chapter + 12 component + 3 renewal-offer migration baseline; live can exceed if hand-tuned).
- Drop the literal `hero=0.9`, `pricing_table=0.78`, `social_proof=0.62`, `image=0.62`, `headline=0.58` pins. Replace with: `hero` is the top chapter by `prior`; `pricing_table` sits in the top three; component-level rows hang off their chapter via `parent_lever_id` (count > 0 in `where parent_lever_id is not null`); `persist_to_renewal_offer` is present (the [[../specs/storefront-renewal-offer-lever|renewal-offer]] lever shipped after the memory spec).
- The behavior assertions (updatePosterior raises/demotes/idempotent dedup, decay → drift toward prior, `general_transfer` seed, M3 reconciler intake) stay as-is — those test the math, not the seed values.

`seedChapterPriorsFromFunnel({apply:true})` is an intended Phase 1 behavior of the original spec ("seed the chapter-level priors from the real funnel data we already have") — its job is to move chapter priors away from cold CRO defaults. Pinning the cold defaults in verification was always going to flap.

## Phase 3 — funnel-dashboard panel empty-state

Flip the conditional at `src/app/dashboard/storefront/funnel/page.tsx:309` from `{data.leverImportance && data.leverImportance.length > 0 && (<LeverImportancePanel rows={…} />)}` to render the section unconditionally when `data.leverImportance` is defined, with a one-line empty-state row when the array is empty: "No learnings yet — every concluded experiment commits one here, win or loss." That makes the verification step independent of whether any posterior row has been written yet, and matches the spec's own framing ("commit the learning to memory, win or loss"). The non-empty render stays as-is.

## Safety / invariants

- **Additive only.** The ALTER is `add column if not exists` with a NOT NULL default — no existing data shape changes, no destructive write. Re-running the apply-script is a no-op once landed.
- **Verification rebaseline doesn't change behavior.** Phase 2 only loosens numeric pins on the *verification checklist* of the original spec; no migration, no code, no lever semantics move. The math assertions stay literal.
- **Empty-state preserves intent.** The panel still shows nothing actionable when there are no learnings — just an honest empty-state instead of a hidden section. No fake data, no placeholders that imply learnings exist.
- **Idempotent re-verify.** Running `apply-storefront-lever-memory-migration.ts` twice prints the same `15 columns` line; calling `updatePosterior` with the same experiment id twice keeps `n_tests` stable (already enforced by `lever-memory.ts:258` evidence-array dedup).
- **Cancels in-flight overlap.** Supersedes [[storefront-lever-importance-restore-seeded-from-column]] so two specs don't race on the same migration; the superseded spec's regression-signature still resolves once this ships.

## Completion criteria

- Live `public.storefront_lever_importance` has 15 columns including `seeded_from text not null default 'cro_prior'`.
- `updatePosterior` writes a row end-to-end on a real terminal experiment (no PostgREST 42703); idempotent re-run keeps `n_tests` stable.
- The funnel page renders the "What the agent believes matters" section on a fresh DB (empty-state) and lists posteriors once any are written.
- The original spec's `## Verification` no longer pins numeric priors that drift; spec-test re-runs and all four previously-failing checks pass.
- Pure-math harness `_spec-test-harness-lever-math.ts` still 14/14 (no regression on `posteriorMean`/`decayedImportance`/`effectFromDelta`).
- The superseded restore-seeded-from-column spec is archived (file deleted in the same PR or its phase emojis flipped to ✅ if archive-on-fold runs separately).

## Verification

- Run `npx tsx scripts/apply-storefront-lever-memory-migration.ts` → expect `✓ applied 20260624120000_storefront_levers.sql`, `✓ applied 20260712120000_storefront_lever_importance_seeded_from.sql`, `✓ public.storefront_lever_importance has 15 columns`, `✓ public.storefront_levers has 12 columns`, and the `seeded ≥ 25 levers (top: hero=…, pricing_table=…, …)` line. Re-run → identical output (idempotent).
- In Supabase confirm `storefront_lever_importance_cell_uniq` on `(lever_id, product_id, lander_type, audience)` and `storefront_levers_parent_idx` on `parent_lever_id` still present in `pg_indexes`.
- Direct PostgREST probe: `admin.from('storefront_lever_importance').select('id, seeded_from').limit(1)` → HTTP 200, no error (was 400/42703 before).
- Re-run the pure-math harness `_spec-test-harness-lever-math.ts` → 14/14 (no regression on the math).
- Let the M1 refresh promote/kill a hero-`image` experiment with a meaningful proxy lift on Amazing Coffee (or call `updatePosterior` directly with its rollups) → `select importance, prior, n_tests, evidence, seeded_from from storefront_lever_importance sli join storefront_levers sl on sl.id=sli.lever_id where sl.lever_key='image';` → row written, `importance > prior`, `n_tests=1`, the experiment id in `evidence`, `seeded_from='cro_prior'` (or `'general_transfer'` if a general learning seeded it). Re-run the refresh on the same terminal experiment → `n_tests` stable (idempotent dedup by experiment id).
- Browse `/dashboard/storefront/funnel` on a fresh workspace (no posteriors yet) → the "What the agent believes matters" section header is visible with the empty-state row "No learnings yet — every concluded experiment commits one here, win or loss." After at least one posterior row exists → the table renders with `importance`, `vs prior`, scope, tests, last-tested age.
- Probe taxonomy shape (replaces the literal-prior assertion): `select chapter, lever_key, prior from storefront_levers where level='chapter' order by prior desc limit 5;` → `hero` is row #1; `pricing_table` is in the top 3; `persist_to_renewal_offer` is present in the result set. `select count(*) from storefront_levers where parent_lever_id is not null;` → > 0 (components hang off chapters). `select count(*) from storefront_levers;` → ≥ 25.
- Re-run spec-test on [[storefront-lever-importance-memory]] → all four previously-failing checks (3143de706a5d0396, 83269bdebbc903d0, 88dc21304e9336f6, 8598fc9e64845434) pass; the origin spec's card clears.
