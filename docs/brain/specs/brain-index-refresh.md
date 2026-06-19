# Brain index refresh — keep archive.md + README counts fresh out-of-band ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

To kill fold-PR contention, folds **no longer commit** the aggregate `docs/brain/archive.md` (the human-readable Index) or `docs/brain/README.md` folder counts — they write only the per-spec `docs/brain/archive.d/{slug}.md` ([[fold-build-batching]] + the 2026-06-19 fold fix). The board is always correct (`getArchive` reads `archive.d/`), but those two **aggregate files now drift** in the repo. Refresh them from a **single writer** on a schedule — so they stay fresh for humans/git without any fold ever touching them (which is what caused the Dirty PRs).

**Business outcome:** `archive.md` + README counts stay accurate, and **no fold PR ever conflicts on them again** (single writer, not N folds).

## Phase 1 — Scheduled single-writer regen ✅
- ✅ New Inngest cron **`brain-index-refresh`** (daily `0 9 * * *`): regenerates the `archive.md` Index from `docs/brain/archive.d/*.md` and the `README.md` folder counts from the actual `docs/brain/` tree. The pure transform is extracted into `src/lib/brain-index.ts` (`regenerateBrainIndex`) so the Inngest runtime can import it; `scripts/brain-index.mjs` keeps a byte-identical zero-dep ESM copy for the box. `/api/inngest` now traces `./docs/brain/**/*.md` (was specs-only) so the cron bundle has the whole tree.
- ✅ If the regenerated content **differs** from `main`, commits **only those two files** to `main` via the GitHub Contents API (same path the authoring chat uses), message `chore: refresh brain index`. **Single writer** → never contends with fold PRs (which no longer write these). (Verified: against the current tree the cron will heal `archive.md` — 9 missing entries — and three stale README counts on its first run.)

## Phase 2 — On-demand + idempotent ✅
- ✅ `node scripts/brain-index.mjs` kept; `npm run brain:index` already wired in `package.json`. The regen is a **no-op when nothing changed** — `commitIfChanged` diffs the regenerated content against live `main` and commits only a real diff, and the commit makes `main` equal to regen output so the next run finds no diff (no empty/loop commits, no CI re-trigger).

## Phase 3 — refresh-on-merge ✅
- ✅ `mergeClaudePr` ([[../libraries/roadmap-actions]]) fires a `brain/index.refresh` Inngest event after a `claude/fold-*` PR merges; the same cron function also listens on that event, so a just-archived spec's Index entry appears within minutes instead of up-to-a-day. Still a single writer.

## Safety / invariants
- **Single writer:** only `brain-index-refresh` commits `archive.md` / README counts. Folds (and everything else) must never write them — that's the whole point. (Enforced by convention; the fold prompt already forbids it.)
- `docs/brain/archive.d/{slug}.md` stays the **source of truth**; this only rebuilds the human-readable aggregates. The board never depends on this job.
- Commit only on a real diff; no-loop guard so the chore commit doesn't trigger more work.

## Completion criteria
- `archive.md` Index + README folder counts stay current (within the schedule) with **zero** per-fold commits to them.
- After archiving N specs, the aggregates reflect all N without any fold PR having touched `archive.md`/README — and no fold PR goes Dirty on them.

## Verification
- On the Inngest dashboard, invoke **`brain-index-refresh`** manually (or wait for the `0 9 * * *` run) → expect a run that commits `docs/brain/archive.md` and/or `docs/brain/README.md` to `main` with message `chore: refresh brain index` **only if** they were drifted; the run output lists the committed paths.
- On `main` after that run, open `docs/brain/archive.md` → expect its `## Index` to list **one entry per `docs/brain/archive.d/*.md`** (newest first), and `docs/brain/README.md` folder counts to match the actual `*.md` count per folder.
- Invoke `brain-index-refresh` a **second** time with no intervening brain change → expect run output `committed: []` (no commit) — the no-op / no-loop guard.
- Locally run `npm run brain:index` on a clean tree → expect `archive.md already current` + `README.md folder counts already current` (no file changes); byte-identical to what the cron produces.
- In `/dashboard/branches`, squash-merge a `claude/fold-*` PR → within minutes expect a `chore: refresh brain index` commit on `main` (the post-merge `brain/index.refresh` event firing the same cron). A non-fold `claude/*` merge → expect **no** such commit.
- After archiving N specs via folds, confirm **no fold PR** touched `archive.md`/README and none went Dirty on them, yet the aggregates reflect all N (single writer healed them).

## Related
[[fold-build-batching]] · [[spec-lifecycle-and-archival]] · [[../archive]] · [[roadmap-build-console]] · [[../inngest/brain-index-refresh]] · [[../libraries/brain-index]] · [[../inngest/slack-roadmap-notify]] · [[../project-management]]
