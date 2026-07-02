# libraries/spec-phase-checks-table

SDK writer/reader for [[../tables/spec_phase_checks]] ([[../specs/pm-structured-intent-and-refs]] Phase 3), the structured replacement for the free-text `spec_phases.verification` blob.

**File:** `src/lib/spec-phase-checks-table.ts`

## Exports

- **`upsertPhaseChecks(phase_id, checks[])`** → `Promise<void>` — REPLACE-by-position writer. Matching positions UPDATE in place (stable id), new positions INSERT, vanished positions DELETE. Idempotent. Called by [[author-spec]] `authorSpecRowStructured` for every phase after `upsertSpec` returns the `phase_ids` map.
- **`listPhaseChecks(phase_id)`** → `Promise<SpecPhaseCheckRow[]>` — ordered by position.
- **`parseVerificationBlobToChecks(blob)`** → `SpecPhaseCheckInput[]` — best-effort split of a free-text verification blob into per-check rows. Splits on `-` / `*` bullet lines; a non-bullet paragraph becomes ONE check. Used by [[author-spec]] to derive `checks` when the caller doesn't pass an explicit array — same rail as the free-text `verification` gate, one layer up.

## Kinds

- **`auto`** — the spec-test agent runs this check directly (non-destructive: `tsc`, gh CI status, Vercel deploy, GET endpoints, read-only DB probes, code imports). Default.
- **`human`** — parked needs_human. The check requires a human verifier (visual/UX, prod-mutating, out-of-box observation).

## Author chokepoint gate

[[author-spec]] `assertEveryPhaseHasChecks` runs BEFORE the DB write and throws `MissingVerificationError` if any phase yields zero checks — an untestable phase never lands.

## Related

[[../tables/spec_phase_checks]] · [[author-spec]] · [[../specs/spec-test-agent]] · [[../specs/pm-structured-intent-and-refs]]
