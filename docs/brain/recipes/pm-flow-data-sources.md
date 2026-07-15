# Recipe: PM-flow data sources (`pm-flow-data-sources`)

The canonical map of HOW the PM flow reads spec state after [[../specs/retire-md-reads-from-pm-flow]] retires every markdown read from the path. **DB row → typed reader → consumer** — no `docs/brain/specs/*.md` HTTP fetch, no `parseSpec` on a raw blob, no `phaseStatesFromRaw` over a markdown string. The "Database is the spec" invariant ([[../../CLAUDE.md]] § Local conventions) becomes enforceable instead of aspirational.

This page is the bar [[../specs/retire-md-reads-from-pm-flow]] Phase 3's `_check-pm-md-reads.ts` enforces in CI — every surviving `serializeSpecRowToMarkdown` caller (or any other md-read site in PM scope) must be listed below or the predeploy check fails red. See `scripts/_audit-pm-md-reads.ts` (Phase 1, the read-only inventory) and [[../libraries/specs-table]].

## The post-purge call graph

The PM flow is "every code path that reads a spec to advance, render, or reconcile its state." There is exactly ONE read shape after Phase 2:

```
public.specs + public.spec_phases  ←   getSpec(workspaceId, slug) / listSpecs(workspaceId, …)
              │                            ↑     (typed SpecRow + SpecPhaseRow[])
              │                            │
              ▼                            │
     spec_phases[i] writers  ──→  stampPhaseShipped(workspaceId, slug, position, { pr, merge_sha })
              │                            │     (the only status-write surface; the trigger is gone)
              │                            │
              ▼                            ▼
         getRoadmap()  ──→  rolled-up status (per-phase) ──→ board / drift / merge effects
```

Every consumer in the PM flow goes through [[../libraries/specs-table]]:

| Consumer | What it reads | How |
|---|---|---|
| Board / Control Tower render | every workspace spec + phases | [[../libraries/brain-roadmap]] `getRoadmap` (sources from `listSpecs`) |
| Build-merge effects | one spec's typed phases | `getSpec` → `spec_phases[i].{ status, body, pr, merge_sha }` directly; no `phaseStatesFromRaw(raw)` |
| Drift reconciler ([[../libraries/spec-drift]] `reconcileSpecDrift`) | one spec's typed phases + each phase's body | `getSpec` → `spec_phases[i].body` for `extractCodePaths`; `spec_phases[i].status` for the per-phase decision |
| Phase advancement | one phase row | [[../libraries/specs-table]] `stampPhaseShipped(workspaceId, slug, position, …)` |
| Fix-link re-test ([[../libraries/agent-jobs]] `retestOriginIfFixMerged`) | one spec's `Fixes:` provenance | the typed `regression_of_slug` column on the `specs` row (the metadata is structured; no markdown line parse) |

## The deliberate-materialization paths (the only surviving consumers of `serializeSpecRowToMarkdown`)

A markdown blob is still produced in a small set of places — by DESIGN, for a downstream consumer that expects markdown. These are the intentional-materialization paths Phase 3's check script allow-lists:

| File · function | Why a markdown blob | Consumer |
|---|---|---|
| `src/lib/brain-roadmap.ts` · `serializeSpecRowToMarkdown` | the definition itself | the call sites below |
| `src/lib/brain-roadmap.ts` · `getSpecMarkdownForCard` | the spec-card preview surface returns `{ raw, card }` for views that still expect a markdown payload | board card preview, in-app spec viewers |
| `src/lib/build-spec-materializer.ts` | the box worker materializes a read-only `.box/spec-{slug}.md` copy of the DB row before invoking the headless build agent ([[../skills/build-spec]]) | the agent's working-tree Read |
| `src/lib/brain-roadmap.ts` · `deriveSpecStatus` | `parseSpec` over an IN-MEMORY raw string (no disk read) — the would-this-fold check ([[../libraries/platform-director]]) on freshly-committed content | a flip-result computation, not a board read |
| `src/lib/author-spec.ts` · `authorSpecRowFromMarkdown` (incl. the in-fn `ENFORCEMENT` block where the `parseSpec` call lands) | the AUTHORING round-trip: `parseSpec` over agent-AUTHORED markdown to UPSERT into `public.specs` + `public.spec_phases` | the DB write (markdown is the agent's output buffer, not a state read) — [[../specs/spec-readers-from-db-retire-parser]] Phase 3 makes `parseSpec` authoring-only |
| `src/lib/author-spec.ts` · `buildStructuredSpecInputFromMarkdown` | the deterministic markdown → `StructuredSpecInput` coercion helper (retire-md-spec-writers-db-is-sole-spec Phase 3): `parseAuthoredSpecMarkdown` over an IN-MEMORY validated markdown STRING (no disk read, no HTTP fetch) → typed shape for the structured DB UPSERT | autonomous author-followup lanes (e.g. platform-director's `applyDirectorAuthorFollowup`) that now funnel legacy markdown followup bodies through the STRUCTURED chokepoint `authorSpecRowStructured` — the markdown is the caller's input buffer being coerced into typed shape, not a spec state read |

Anything ELSE — any future caller of `serializeSpecRowToMarkdown` or any new `docs/brain/specs/` fetch in PM scope — fails `_check-pm-md-reads.ts`. The allow-list lives in `scripts/_audit-pm-md-reads.ts` (`INTENTIONAL_MATERIALIZATION`) so the audit + the check share one source of truth.

## What got retired (Phase 2 deletes)

- `fetchSpecRawFromMain(slug)` — the HTTP-from-`main` raw-markdown fetcher. PM callers swap to `getSpec(workspaceId, slug)`; if a non-PM consumer (e.g. a fold-archive viewer) needs the historical archived markdown, the function survives RENAMED `fetchArchivedSpecMarkdown` with that single caller documented above.
- `parseSpec` / `phaseStatesFromRaw` / `mergePhaseStates` on a markdown blob — replaced by reading the typed `spec_phases` rows directly. The parsers are scoped to the round-trip materialization path only (Bo's per-build `.box/spec-{slug}.md`, fold input).
- `parsePhaseIndices(opts.instructions, phaseCount)` — kept. It parses the BUILD INSTRUCTIONS ("Phase 2 — …" hint), not a spec body.
- The `phase_states` argument to `markSpecCardMergeShipped` — gone. The per-phase truth IS `spec_phases`; the spec-level `last_merge_sha` / `merged_pr` / `flags` write stays.

## How the audit + check scripts work together

Phase 1 — `scripts/_audit-pm-md-reads.ts`: walks the PM-flow file set, greps for every md-read pattern, classifies each finding, and emits a JSON manifest. Read-only; safe to run anywhere.

```bash
npx tsx scripts/_audit-pm-md-reads.ts                 # full JSON manifest
npx tsx scripts/_audit-pm-md-reads.ts --summary       # one-line counts
npx tsx scripts/_audit-pm-md-reads.ts --jsonl         # one finding per line
```

Phase 3 — `scripts/_check-pm-md-reads.ts` (the regression door): runs the same audit and exits non-zero when a `pm-read-to-retire` finding appears outside `INTENTIONAL_MATERIALIZATION`. Wired into `npm run typecheck` / `predeploy` so a new `docs/brain/specs/` read in PM scope breaks CI red, not silently.

## Why this page is the bar, not the docs

Code without an entry on this page is unreachable from PM today. Adding a new caller of `serializeSpecRowToMarkdown` (or any of the retired markdown readers) requires:

1. adding a row to the table above with the consumer + the reason markdown is the right shape, AND
2. adding the same `(file, fn, reason)` triple to `INTENTIONAL_MATERIALIZATION` in `scripts/_audit-pm-md-reads.ts`.

A new addition that doesn't update both — the check script fails. That's the loop being closed: silent drift back to `.md` reads can't happen, and the "Database is the spec" invariant has a referee.
