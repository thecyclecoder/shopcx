# libraries/director-box-snapshot

A typed, single-shot **snapshot of the box** for the director-coach turn prompt ([[../specs/director-coach-canonical-box-snapshot]]). The director narrates from THIS payload, never from memory of the `agent_jobs` status enum or hand-rolled SQL — the recurring failure mode the spec exists to prevent.

**File:** `src/lib/agents/director-box-snapshot.ts` · **Reads:** [[../tables/agent_jobs]] · [[../tables/director_directives]] · [[../tables/director_activity]] · [[../tables/spec_card_state]] · **Test:** `src/lib/agents/director-box-snapshot.test.ts` (run `npm run test:director-box-snapshot`)

## Why (the misreads it prevents)
- **Wrong enum.** Filtering on `status in ('queued','running','in_progress','needs_attention')` returns nothing because `running` / `in_progress` aren't in the [[../tables/agent_jobs]] enum. The coach read "box is empty" off a broken query and replied that to the CEO.
- **Wrong source for pass cadence.** [[../tables/director_activity]] logs WRITE actions (flips, dismisses, fold-queues), not run cadence. Reading it for "did Ada pass recently?" missed five `platform-director` runs.
- **Phantom phase drift.** An ad-hoc filter on `spec_card_state` mis-named a column and reported phantom drift.

The fix is structural: the coach turn prompt carries a canonical payload before it opens its mouth.

## Exports
- **`getDirectorBoxSnapshot(workspaceId, directorFunction)`** → `Promise<DirectorBoxSnapshot>` — the single entry point. Bootstraps via `createAdminClient()` (CLAUDE.md invariant), runs the underlying reads in parallel, never throws (each branch falls back to its empty shape).
- **`bucketizeJobs(rows, now)`** → `JobBuckets` — pure grouper used by both the entry point and the unit tests. Drops unknown statuses; every known status is present as `0` so the prompt reads "needs_attention: 0" safely.
- **`groupParkedByClass(rows, now)`** → `ParkedClassBucket[]` — pure grouper for `needs_attention` rows by `needs_attention_class` (NULL → `'unclassified'`), largest-first.
- **`BOX_ACTIVE_STATUSES`** — `[queued, claimed, building, needs_input, needs_approval, queued_resume, blocked_on_usage]`.
- **`BOX_PARKED_STATUSES`** — `[needs_attention, held, dismissed]`.
- **`BOX_TERMINAL_STATUSES`** — `[completed, failed]`.
- **Types:** `DirectorBoxSnapshot`, `JobBuckets`, `JobSample`, `DirectorPass`, `ParkedClassBucket`, `ActiveDirectiveSnapshot`, `DirectorWrite`, `BoxActiveStatus`, `BoxParkedStatus`, `BoxTerminalStatus`, `BoxStatus`, `RawJobRow`.

## Snapshot shape
```
{
  workspace_id, director_function, generated_at,
  jobs: {
    counts: { queued, claimed, building, needs_input, needs_approval, queued_resume,
              blocked_on_usage, needs_attention, held, dismissed, completed, failed },
    samples: { <status>: JobSample[≤3] },
  },
  recentDirectorPasses: DirectorPass[≤10],          // agent_jobs kind='platform-director' desc by created_at
  parkedByClass: ParkedClassBucket[],               // needs_attention grouped by needs_attention_class
  activeDirective: ActiveDirectiveSnapshot | null,  // includes age_minutes + critical_specs (flags.critical=true)
  recentDirectorWrites: DirectorWrite[≤10],         // director_activity desc by created_at (this director only)
}
```

## Reads (one per source)
- **`agent_jobs`** — two queries: `in BOX_ACTIVE_STATUSES ∪ BOX_PARKED_STATUSES` (any age) + `in BOX_TERMINAL_STATUSES` (last 2h). Combined, then split by the pure bucketizer.
- **`agent_jobs` (pass cadence)** — `kind='platform-director'`, desc by `created_at`, limit 10. NOT `director_activity`.
- **`director_directives`** — the one `status='active'` row (via [[director-directives]] `getActiveDirective`), age-stamped + paired with the list of spec slugs currently carrying `flags.critical=true` in [[../tables/spec_card_state]] (the "critical_specs" view).
- **`director_activity`** — desc by `created_at`, limit 10, filtered to `director_function`.

## Status enum canonicalization
Phase 3 of the spec replaces ad-hoc enum lists in `src/lib/agents/` (every place that hand-writes "queued/building/…" today) with imports from this module — one source of truth for what "active" / "parked" mean, so a lane can never drift onto a wrong filter again.

## Callers
- `scripts/builder-worker.ts` — `runDirectorCoachJob` calls it per turn and inlines a BOX SNAPSHOT block at the top of the coach prompt (Phase 2). The same payload also drives Phase 2's post-reply sanity guard.

## Gotchas
- **`running` / `in_progress` are intentionally absent** from `BOX_ACTIVE_STATUSES`. The unit test asserts this — including them is the literal bug this spec exists to prevent.
- **Pure bucketizers are the test surface.** `bucketizeJobs` + `groupParkedByClass` take a list of rows + `now`, no DB. Easier to seed one row per status + assert grouping than to seed the live `agent_jobs`.
- **Best-effort by design.** A failed read on any sub-source returns the empty shape — the coach turn must never block on a transient DB hiccup.

## Related
[[../specs/director-coach-canonical-box-snapshot]] · [[../tables/agent_jobs]] · [[../tables/director_directives]] · [[../tables/director_activity]] · [[../tables/spec_card_state]] · [[director-directives]] · [[platform-director]] · [[../specs/director-executable-plans-and-priority]] · [[../specs/no-parked-specs-auto-route-needs-attention]]
