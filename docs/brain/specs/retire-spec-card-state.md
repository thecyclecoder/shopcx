## Retire the spec_card_state mirror — flip readers to specs, drop the table

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/db-driven-specs]] M4 — Fold writes the brain + preserves the row
**Blocked-by:** [[spec-fold-from-db-row]]

The contract step of the expand-contract retirement that [[spec-fold-from-db-row]] Phase 2 started. That phase ADDED the post-retirement homes on `public.specs` (`last_merge_sha`, `short_circuit`, `short_circuit_reason`, `vale_pass`, `ada_disposition`, `merged_pr`) + wired the dual-write (every [[../libraries/spec-card-state]] writer now mirrors to the new typed columns) + backfilled existing rows. The mirror table is intact and still authoritative for reads.

This spec finishes the job: flip readers to read `specs` directly (no more `from("spec_card_state")` anywhere), delete the [[../libraries/spec-card-state]] library (or leave a stub redirect for one release cycle), and drop the [[../tables/spec_card_state]] table. After this spec [[../tables/spec_status_history]] is the only spec-state mirror left — the audit ledger, never the source of truth.

## Phase 1 — flip the readers + the writers to `public.specs`
- Every reader of `spec_card_state` cuts over to the equivalent read on `public.specs` (+ `public.spec_phases` for per-phase progress). The board (`src/app/dashboard/roadmap/page.tsx`), the slug page (`src/app/dashboard/roadmap/[slug]/page.tsx`), the spec-status API routes (`src/app/api/roadmap/{status,priority,spec-drift}/route.ts`), the spec-drift reconciler ([[../libraries/spec-drift]]), the spec-audit script ([[../libraries/spec-audit]]), the agent-jobs merge-effect writer ([[../libraries/agent-jobs]] `applyMergedBuildEffects`), and the spec-review / spec-dispose / platform-director agents all read the new typed columns instead.
- The writers in [[../libraries/spec-card-state]] (the `markSpecCard*` family — `markSpecCardStatus`, `markSpecCardCritical`, `markSpecCardDeferred`, `markSpecCardMergeShipped`, `markSpecCardBlocked`, `markSpecCardForReview`, `markSpecCardValePassed`, `applyAdaDisposition`, `markSpecCardPendingUpgrade`, `markSpecCardBackToReview`, `markSpecCardShortCircuit`) collapse to thin wrappers over [[../libraries/specs-table]] — same signatures, same audit-row write to `spec_status_history`, but the underlying UPDATE targets `public.specs` directly. No more `from("spec_card_state").upsert(...)`. Helpers (`rollupPhaseStatus`, `resolveBoardStatus`, `mergePhaseStates`, `effectiveStatusFromState`, `deploymentState`) reshape their inputs to read off the `SpecRow` from [[../libraries/specs-table]] instead of the prior `SpecCardState` shape. `deploy_pending` is computed at read time (`last_merge_sha !== VERCEL_GIT_COMMIT_SHA`) — no column. `blocked` is computed from `blocked_by` + the sibling specs' status — no column.
- Verification — Phase 1: `grep -rn 'from("spec_card_state")' src/` returns zero matches. The board + the slug page + the API routes + every agent compile and behave identically (status flips land instantly, the deploy chip flips correctly, Vale → Ada → CEO disposition lane unchanged).

## Phase 2 — drop the table + retire the library
- Drop the mirror: `supabase/migrations/{YYYYMMDDNNNNNN}_drop_spec_card_state.sql` + apply script. Idempotent (`DROP TABLE IF EXISTS public.spec_card_state CASCADE`). The CASCADE handles any leftover FKs (RLS policies on the table go with it). [[../tables/spec_status_history]] STAYS — it's the audit ledger.
- Delete [[../libraries/spec-card-state]]. The helpers it exposed (`rollupPhaseStatus`, `mergePhaseStates`, `resolveBoardStatus`, `effectiveStatusFromState`, `deploymentState`) move to [[../libraries/specs-table]] (or stay where they are if the callers are simple to relocate). The `markSpecCard*` writers become methods on [[../libraries/specs-table]] (`writeSpecStatus`, `writeSpecCritical`, `writeSpecDeferred`, `writeSpecMergedShipped`, `writeSpecForReview`, `writeSpecValePassed`, `applySpecDisposition`, `writeSpecPendingUpgrade`, `writeSpecBackToReview`, `writeSpecShortCircuit`). Optionally: a `src/lib/spec-card-state.ts` stub that re-exports from [[../libraries/specs-table]] for one release cycle to catch any external consumers, then deleted.
- Scrub references: every wikilink to `[[../tables/spec_card_state]]` / `[[../libraries/spec-card-state]]` in `docs/brain/` updates to the equivalent specs-table / specs-row reference. `docs/brain/tables/spec_card_state.md` is removed (the table is gone) — its content folds into [[../tables/specs]] (the new home for the same fields) and into [[../tables/spec_phases]] (where per-phase progress now lives). The same scrub runs in `scripts/builder-worker.ts` (the worker's prompt strings + comments cite the mirror today).
- Verification — Phase 2: `grep -rn 'spec_card_state' src/ docs/brain/ scripts/` returns zero matches. The table is gone (`select count(*) from information_schema.tables where table_name='spec_card_state'` → 0). The board still renders every active and archived spec correctly; status flips still land instantly; the deploy chip still distinguishes `shipped · deploying` from `shipped · live`; the audit ledger ([[../tables/spec_status_history]]) still records every transition.

## Safety / invariants
- **Expand-contract.** [[spec-fold-from-db-row]] did the EXPAND (add the new homes + dual-write + backfill); this spec is the CONTRACT (cut over readers + drop the table). The two are sequenced via this spec's `Blocked-by` line — the contract MUST NOT start until the dual-write has run cleanly in production for at least one fold cycle, so every existing folded row's typed columns are populated.
- **Dual-write disable last.** Once readers cut over (Phase 1), the dual-write in [[../libraries/spec-card-state]] still writes to `spec_card_state` AND `specs` — leave it there until Phase 2 drops the table; that way a rollback of Phase 1 only needs to revert the reader cutover, not the writes.
- **No data loss.** The Phase 2 migration in [[spec-fold-from-db-row]] backfilled every row. Pre-drop, verify: `select count(*) from public.spec_card_state where (last_merge_sha is distinct from (select s.last_merge_sha from public.specs s where s.workspace_id=spec_card_state.workspace_id and s.slug=spec_card_state.spec_slug))` → 0 (same for the five flag columns).
- **`spec_status_history` stays.** It's the audit ledger of every transition — orthogonal to the mirror, and the durable record once the mirror is gone.

## Completion criteria
- Zero `spec_card_state` references in src/, docs/brain/, scripts/ (allowing a one-release-cycle library stub if needed).
- `public.spec_card_state` table dropped.
- Board + slug page + API routes + agents render the same content from `public.specs` + `public.spec_phases` they used to render from the mirror.
- [[../tables/spec_status_history]] retained, every recent flip still has an audit row.

## Verification
- `grep -rn 'spec_card_state' src/ docs/brain/ scripts/` → no matches (after the stub, if any, is removed).
- Roadmap board (`/dashboard/roadmap`): every column (In Review / Planned / In progress / Shipped / Deferred / Archived) shows the same set of cards before and after.
- Status flip via the board's owner-status control: still instant (no Vercel redeploy required).
- A merged build PR: the card still flips to `shipped · deploying`; the next deploy carrying the merge SHA flips it to `shipped · live`.
- `spec_status_history`: a transition during Phase 1 cutover still appears (the audit write must NOT regress).
- `select count(*) from information_schema.tables where table_schema='public' and table_name='spec_card_state'` → 0.
