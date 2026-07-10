# libraries/build-spec-materializer

Renders a spec row + its [[../tables/spec_phases]] children to a temp markdown file the [[../skills/build-spec]] skill (and [[../skills/fold-to-brain]] during folding) consumes. Authored by [[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 2; adopted by [[../specs/spec-fold-from-db-row]] Phase 1 to enable DB-driven folding.

**File:** `src/lib/build-spec-materializer.ts`

## Why this exists

Phase 1 of [[../specs/spec-authoring-writes-db-and-worker-materialize]] dual-wrote every author surface to [[../tables/specs]] + [[../tables/spec_phases]]. Phase 2 cuts the BUILD side over so Bo (the [[../skills/build-spec]] skill) reads the DB row — not `docs/brain/specs/{slug}.md` — even though the markdown still exists on `main` (dual-write Phase 4 keeps the mirror commit live until [[../specs/spec-readers-from-db-retire-parser]] retires the parser). The box worker's `runBuildJob` calls `materializeSpec` to render the row to `${wt}/.box/spec-${slug}.md` and hands the build-spec skill that path. Bo never needs the `.md` under `docs/brain/specs/`. Later, [[../specs/spec-fold-from-db-row]] Phase 1 reuses the same materializer so the fold-to-brain skill reads specs from the DB (via the same in-memory text shape) rather than parsing `docs/brain/specs/{slug}.md` — enabling the spec row to be preserved with `status='folded'` post-fold rather than deleted.

## Exports

- **`materializeSpec(workspaceId, slug, dir)`** → `Promise<{ path: string; row: SpecRow }>` — joins `specs` + `spec_phases` (ordered by `position`) via [[specs-table]] `getSpec`, fetches each phase's typed verification checks via [[spec-phase-checks-table]] `checksByPhaseIdForRender(phaseIds)`, renders the brain-spec markdown shape, writes to `${dir}/spec-${slug}.md`, and returns BOTH the absolute path AND the `SpecRow` it rendered from. The row is returned so the build gate validates on the DB ROW, not a regex over the rendered markdown ("the database is the spec"). Creates `dir` if missing. Throws when no `specs` row exists for `(workspaceId, slug)` — the caller is responsible for upstream existence (the build dispatch gate refuses an unknown spec).
- **`renderSpecRow(row, checksByPhaseId?)`** → `string` — pure renderer over a `SpecRow`. Exported so tests + the brain page show the exact shape without disk I/O. The optional `checksByPhaseId` map (keyed by `spec_phases.id` → `[{ description }]` in position order — the shape [[spec-phase-checks-table]] `checksByPhaseIdForRender` returns) is the **checks-source-of-truth render**: when supplied, each phase's `### Verification` block is rendered FROM the typed [[../tables/spec_phase_checks]] rows (one `- {description}` bullet per check) instead of dumping the `spec_phases.verification` TEXT column. A phase with NO checks rows falls back to its `verification` column (transitional). Called WITHOUT the map, it renders from the column exactly as before — **backward compatible**. This is the founder invariant "a render can take DB items and add markdown; don't store markdown elements in the DB as data objects": the DB holds typed check rows, the `### Verification` markdown is synthesized at render time.
- **`specHasBuildableContent(row)`** → `boolean` — the DB-row buildability check. `true` iff the row carries real content: ≥1 `spec_phases` row with a non-empty title OR body (multi-phase), OR a non-empty `summary` (one-shot). The build gate keys on THIS, not a `## Phase` markdown match — so a valid spec whose phase titles don't literally start with "Phase", and a one-shot spec with no `## Phase` heading at all, both build.
- **`unbuildableReason(row)`** → `string` — human-readable reason a row is NOT buildable, or `""` when it is. Used for the gate's `failed` job message.

## Rendered shape

- `# {title}` — H1, NO status emoji ([[../specs/spec-status-db-driven]] rule: the materialized file is content-only).
- `**Owner:** [[../functions/{owner}]] · **Parent:** {parent}` — metadata line (only the parts that exist).
- `**Blocked-by:** [[slug-a]], [[slug-b]]` — when `blocked_by` is non-empty.
- The `summary` paragraph as a single block. **Brain refs are a `spec_brain_refs` RELATION now ([[../specs/pm-structured-intent-and-refs]] Phase 2)** — 0-4 rows per spec/phase, `brain_slug` values like `libraries/foo` or `tables/foo`. The materialized body may list them in a `**Brain refs:**` block for READABILITY, but the DB rows are authoritative — the CI ref check (`scripts/_check-brain-refs.ts`) refuses a dangling row. The [[../skills/build-spec]] skill Reads each `docs/brain/{brain_slug}.md` FIRST as the authoritative brain slice for the build.
- `## Phase {N} — {phase.title}` per phase (1..N, ordered by `position`), followed by `phase.body`. The `Phase N — ` prefix is added unless the stored title already leads with "Phase" (don't double it).
- `### Verification` under each phase — rendered from the phase's typed [[../tables/spec_phase_checks]] rows (one `- {description}` bullet per check) when `renderSpecRow` is called with a `checksByPhaseId` map that has rows for that phase; otherwise from the `spec_phases.verification` TEXT column (the transitional fallback for a phase with no checks rows). Emitted only when the phase yields at least one check line either way.

The H1 + per-phase headings carry NO status emoji — `spec-status-db-driven` made status DB-driven, and this file is the BUILD-FACING body (not the board surface).

**The canonical `## Phase N — title` heading is for READABILITY + the markdown-mirror `parseSpec` reader, NOT for validation.** The build gate trusts the DB ROW (`specHasBuildableContent`), so the heading is no longer load-bearing — the existence of a `spec_phases` row (with a title/body) or a non-empty summary is what makes a spec buildable. The materialized markdown is a render Bo READS, never the gate. (Before: the gate ran `/^#{2,3}\s+Phase/m` over the materialized text, which wrongly refused valid specs whose phase titles didn't literally start with "Phase".)

### What is NOT rendered

The `## Safety / invariants` and `## Completion criteria` sections are NOT captured by Phase 1's author flow (the [[author-spec]] writer extracts only summary + phases, and the schema has no columns for these blocks). The dual-write mirror commit on `main` preserves them in `docs/brain/specs/{slug}.md` for the parser readers — a follow-up spec is the right place to add columns + extract these into the DB.

### `### Verification` is rendered FROM the typed check rows — `checkKey`-stable

The verification render was flipped from "dump the `spec_phases.verification` markdown-as-data column" to "synthesize `- {description}` bullets from the [[../tables/spec_phase_checks]] rows" WITHOUT changing what any downstream reader matches on:

- **`checkKey`-stable across all 928 phases** — `scripts/_prove-checkkey-stable-render-flip.ts` rendered every phase both ways and found **0 drift** in the derived `checkKey` set. `checkKey` normalizes whitespace, so `- {description}` yields the identical key set the spec-test / green / regression matchers already key on. The rows carry the same descriptions the column held; only the storage-vs-render location moved.
- **Who reads the render (and sees semantically identical verification):** Vera ([[../skills/spec-test]]), Vale ([[../skills/spec-review]]), and Bo ([[../skills/build-spec]]) all read the MATERIALIZED markdown, so the flip is invisible to them.
- **The roadmap board is insulated entirely** — it reads the phase-status rollup + [[../tables/spec_test_runs]], never the `verification` column or this render. No board surface depends on the storage location.

## Wiring

- **Build path:** `scripts/builder-worker.ts` `runBuildJob` calls `materializeSpec(job.workspace_id, slug, "${wt}/.box")` before dispatching the [[../skills/build-spec]] skill. The temp `.box/` directory is gitignored, so `git add -A` skips it.
- **Fold path:** `scripts/builder-worker.ts` `runFoldJob` calls the same `materializeSpec` for each shipped spec (guarded by `status='shipped'`), then dispatches the [[../skills/fold-to-brain]] skill with the materialized path. After fold commits, the worker updates the DB row to `status='folded'` (preserved, not deleted).
- The materialized file is regenerated on EVERY dispatch (fresh + resume) — the worktree is wiped at the top of every run, and the spec row may have been edited between rounds.
- The db-health-spec-body-robust check (contentless-spec refusal) runs over the DB ROW via `specHasBuildableContent` — NOT a regex over the materialized markdown. A genuinely-empty row (no phases with title/body AND no summary) produces a clean `failed` job ("refusing to build an empty spec") instead of a silent empty PR; everything with real row content builds. `materializeSpec` returns the `row` to the gate so it never re-reads the file to validate.

## Gotchas

- **No emoji on H1 / phase headings.** Status is DB-driven; emojis would mislead the agent into trusting a stale marker over the row.
- **Throws when the row is missing.** Bo can't build a spec that doesn't exist as a DB row — the worker treats this as a build failure, not a fallback to disk.
- **Single source of truth for content.** Bo MUST NOT read `docs/brain/specs/{slug}.md` directly; the row is canonical for the build path even though the .md remains for parser readers.
- **Markdown is a render, not a gate.** The build's buildability check keys on the DB row (`specHasBuildableContent`), never a magic markdown heading/phrase. A spec exists because its rows exist — "phases are a db row, specs are a db row; the existence of the row means it exists, no magic phrases or markdown needed." Don't reintroduce a `/## Phase/`-style regex gate over the materialized text.

## Related

[[specs-table]] · [[spec-phase-checks-table]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../tables/spec_phase_checks]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../specs/spec-status-db-driven]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-fold-from-db-row]] · [[author-spec]] · [[../skills/build-spec]] · [[../skills/fold-to-brain]]
