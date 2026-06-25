# libraries/build-spec-materializer

Renders a spec row + its [[../tables/spec_phases]] children to a temp markdown file the [[../skills/build-spec]] skill consumes. Authored by [[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 2.

**File:** `src/lib/build-spec-materializer.ts`

## Why this exists

Phase 1 of [[../specs/spec-authoring-writes-db-and-worker-materialize]] dual-wrote every author surface to [[../tables/specs]] + [[../tables/spec_phases]]. Phase 2 cuts the BUILD side over so Bo (the [[../skills/build-spec]] skill) reads the DB row — not `docs/brain/specs/{slug}.md` — even though the markdown still exists on `main` (dual-write Phase 4 keeps the mirror commit live until [[../specs/spec-readers-from-db-retire-parser]] retires the parser). The box worker's `runBuildJob` calls `materializeSpec` to render the row to `${wt}/.box/spec-${slug}.md` and hands the build-spec skill that path. Bo never needs the `.md` under `docs/brain/specs/`.

## Exports

- **`materializeSpec(workspaceId, slug, dir)`** → `Promise<string>` — joins `specs` + `spec_phases` (ordered by `position`) via [[specs-table]] `getSpec`, renders the brain-spec markdown shape, writes to `${dir}/spec-${slug}.md`, returns the absolute path. Creates `dir` if missing. Throws when no `specs` row exists for `(workspaceId, slug)` — the caller is responsible for upstream existence (the build dispatch gate refuses an unknown spec).
- **`renderSpecRow(row)`** → `string` — pure renderer over a `SpecRow`. Exported so tests + the brain page show the exact shape without disk I/O.

## Rendered shape

- `# {title}` — H1, NO status emoji ([[../specs/spec-status-db-driven]] rule: the materialized file is content-only).
- `**Owner:** [[../functions/{owner}]] · **Parent:** {parent}` — metadata line (only the parts that exist).
- `**Blocked-by:** [[slug-a]], [[slug-b]]` — when `blocked_by` is non-empty.
- The `summary` paragraph as a single block.
- `## {phase.title}` per phase (1..N, ordered by `position`), followed by `phase.body`. When `phase.verification` is set the renderer emits `### Verification` under the phase.

The H1 + per-phase headings carry NO status emoji — `spec-status-db-driven` made status DB-driven, and this file is the BUILD-FACING body (not the board surface).

### What is NOT rendered

The `## Safety / invariants` and `## Completion criteria` sections are NOT captured by Phase 1's author flow (the [[author-spec]] writer extracts only summary + phases, and the schema has no columns for these blocks). The dual-write mirror commit on `main` preserves them in `docs/brain/specs/{slug}.md` for the parser readers — a follow-up spec is the right place to add columns + extract these into the DB.

## Wiring

- `scripts/builder-worker.ts` `runBuildJob` calls `materializeSpec(job.workspace_id, slug, "${wt}/.box")` before dispatching the [[../skills/build-spec]] skill. The temp `.box/` directory is gitignored, so `git add -A` skips it.
- The materialized file is regenerated on EVERY dispatch (fresh + resume) — the worktree is wiped at the top of every run, and the spec row may have been edited between rounds.
- The db-health-spec-body-robust check (0-byte / phaseless refusal) runs over the MATERIALIZED file, so an empty row produces a clean `failed` job instead of a silent empty PR.

## Gotchas

- **No emoji on H1 / phase headings.** Status is DB-driven; emojis would mislead the agent into trusting a stale marker over the row.
- **Throws when the row is missing.** Bo can't build a spec that doesn't exist as a DB row — the worker treats this as a build failure, not a fallback to disk.
- **Single source of truth for content.** Bo MUST NOT read `docs/brain/specs/{slug}.md` directly; the row is canonical for the build path even though the .md remains for parser readers.

## Related

[[specs-table]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../specs/spec-status-db-driven]] · [[../specs/spec-readers-from-db-retire-parser]] · [[author-spec]] · [[../skills/build-spec]]
