# libraries/spec-phase-checks-table

SDK writer/reader for [[../tables/spec_phase_checks]] ([[../specs/pm-structured-intent-and-refs]] Phase 3), the structured replacement for the free-text `spec_phases.verification` blob.

**File:** `src/lib/spec-phase-checks-table.ts`

## Rows are the render source of truth

The typed `spec_phase_checks` rows — NOT the `spec_phases.verification` TEXT column — are now the source of truth for a spec's verification. [[build-spec-materializer]] `renderSpecRow` synthesizes each phase's `### Verification` markdown FROM these rows (one `- {description}` bullet per check) via the `checksByPhaseIdForRender` map below, falling back to the `verification` column only for a phase that has no rows (the transitional fallback). This is the founder invariant "a render can take DB items and add markdown; don't store markdown elements in the DB as data objects" — the DB holds typed check objects; the markdown is a render-time artifact. Proven `checkKey`-stable across all 928 phases (`scripts/_prove-checkkey-stable-render-flip.ts`, 0 drift), so Vera / Vale / Bo see semantically identical verification.

## Exports

- **`upsertPhaseChecks(phase_id, checks[])`** → `Promise<void>` — REPLACE-by-position writer. Matching positions UPDATE in place (stable id), new positions INSERT, vanished positions DELETE. Idempotent. Called by [[author-spec]] `authorSpecRowStructured` for every phase after `upsertSpec` returns the `phase_ids` map.
- **`listPhaseChecks(phase_id)`** → `Promise<SpecPhaseCheckRow[]>` — ordered by position.
- **`checksByPhaseIdForRender(phaseIds[])`** → `Promise<Map<phase_id, { description }[]>>` — the batched render-source reader. Fetches every check for the given phase ids in ONE query and returns a `spec_phases.id → [{ description }]` map in position order — the exact shape [[build-spec-materializer]] `renderSpecRow(row, checksByPhaseId?)` consumes to synthesize `### Verification` bullets. `materializeSpec` calls it with the spec's phase ids and passes the map to `renderSpecRow`. A phase absent from the map (no rows) falls back to its `spec_phases.verification` column.
- **`parseVerificationBlobToChecks(blob)`** → `SpecPhaseCheckInput[]` — best-effort split of a free-text verification blob into per-check rows. Splits on `-` / `*` bullet lines; a non-bullet paragraph becomes ONE check. Used by [[author-spec]] to derive `checks` when the caller doesn't pass an explicit array — same rail as the free-text `verification` gate, one layer up.

## Kinds

- **`auto`** — the spec-test agent runs this check directly (non-destructive: `tsc`, gh CI status, Vercel deploy, GET endpoints, read-only DB probes, code imports). Default.
- **`human`** — parked needs_human. The check requires a human verifier (visual/UX, prod-mutating, out-of-box observation).

## Author chokepoint gate

[[author-spec]] `assertEveryPhaseHasChecks` runs BEFORE the DB write and throws `MissingVerificationError` if any phase yields zero checks — an untestable phase never lands.

## Related

[[../tables/spec_phase_checks]] · [[build-spec-materializer]] · [[specs-table]] · [[author-spec]] · [[../specs/spec-test-agent]] · [[../specs/pm-structured-intent-and-refs]]
