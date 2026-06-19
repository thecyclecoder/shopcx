# libraries/brain-index

The **pure transform** behind the two contended aggregate brain files — extracted so the Inngest runtime can regenerate them out-of-band ([[../inngest/brain-index-refresh]]). Deterministic dir/string transforms: no GitHub, no network. The caller diffs against `main` and commits only a real change.

**File:** `src/lib/brain-index.ts`

## What it regenerates

1. `docs/brain/archive.md` "## Index" ← `docs/brain/archive.d/*.md` (one entry line per archived spec — newest first, tie-broken by slug). The board's source of truth stays `archive.d/` ([[brain-roadmap]]`.getArchive`); this only rebuilds the human-readable aggregate.
2. `docs/brain/README.md` folder counts ← the actual `*.md` file count per folder (`tables`, `inngest`, … `specs`; `dashboard` reports its `settings/` subfolder separately).

## Exports

- `regenerateBrainIndex(brainDir)` → `{ archive, readme }`. Each is `{ path, content }` (repo-relative path + freshly regenerated content) or `null` when its source/markers are missing (skip). Reads the `docs/brain/` tree under `brainDir`; never writes.
- `RegenFile` / `RegenResult` types.

## Callers

- [[../inngest/brain-index-refresh]] — the single scheduled writer (reads the bundled tree, commits a real diff to `main`).

## Gotchas

- **Two copies, kept in sync by hand.** `scripts/brain-index.mjs` holds a zero-dep ESM copy of this same logic for local/manual `npm run brain:index` (the box runs it with bare `node`, no tsx, in any worktree). Node can't import the `.ts` lib, so the logic is duplicated — change both. (The same pattern as [[brain-roadmap]]`.getArchive` re-parsing `archive.d/`.)
- Output is **byte-identical** to the mjs script's, so a regen from either side is a no-op for the other.
- `archive.md` regen needs the `<!-- archive-index … -->` marker and a `## Related` heading; without them it returns `null` (skips) rather than mangling the file.

## Related

[[../inngest/brain-index-refresh]] · [[brain-roadmap]] · [[../archive]] · [[../specs/fold-build-batching]] · [[../project-management]]

---

[[../README]] · [[../../CLAUDE]]
