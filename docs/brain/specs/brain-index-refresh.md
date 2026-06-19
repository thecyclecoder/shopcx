# Brain index refresh — keep archive.md + README counts fresh out-of-band ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

To kill fold-PR contention, folds **no longer commit** the aggregate `docs/brain/archive.md` (the human-readable Index) or `docs/brain/README.md` folder counts — they write only the per-spec `docs/brain/archive.d/{slug}.md` ([[fold-build-batching]] + the 2026-06-19 fold fix). The board is always correct (`getArchive` reads `archive.d/`), but those two **aggregate files now drift** in the repo. Refresh them from a **single writer** on a schedule — so they stay fresh for humans/git without any fold ever touching them (which is what caused the Dirty PRs).

**Business outcome:** `archive.md` + README counts stay accurate, and **no fold PR ever conflicts on them again** (single writer, not N folds).

## Phase 1 — Scheduled single-writer regen ⏳
- ⏳ New Inngest cron **`brain-index-refresh`** (daily, e.g. `0 9 * * *`): regenerate the `archive.md` Index from `docs/brain/archive.d/*.md` and the `README.md` folder counts from the actual `docs/brain/` tree (the logic in `scripts/brain-index.mjs` — extract the pure transform into a lib the Inngest runtime can import, since the box script uses the filesystem). `docs/brain/**` is already traced into the function bundle.
- ⏳ If the regenerated content **differs** from `main`, commit **only those two files** to `main` via the GitHub Contents API (same path the authoring chat uses), message `chore: refresh brain index`. **Single writer** → never contends with fold PRs (which no longer write these).

## Phase 2 — On-demand + idempotent ⏳
- ⏳ Keep `node scripts/brain-index.mjs` (and add `npm run brain:index`) for local/manual refresh. The regen is a **no-op when nothing changed** — only a real diff produces a commit (no empty/loop commits; guard against re-triggering CI/builds).

## Phase 3 — (optional) refresh-on-merge ⏳
- ⏳ For near-real-time freshness instead of up-to-a-day: trigger the same regen right after a `claude/fold-*` PR merges (a lightweight webhook/Action), so the archive Index reflects a just-archived spec within minutes. Still a single writer.

## Safety / invariants
- **Single writer:** only `brain-index-refresh` commits `archive.md` / README counts. Folds (and everything else) must never write them — that's the whole point. (Enforced by convention; the fold prompt already forbids it.)
- `docs/brain/archive.d/{slug}.md` stays the **source of truth**; this only rebuilds the human-readable aggregates. The board never depends on this job.
- Commit only on a real diff; no-loop guard so the chore commit doesn't trigger more work.

## Completion criteria
- `archive.md` Index + README folder counts stay current (within the schedule) with **zero** per-fold commits to them.
- After archiving N specs, the aggregates reflect all N without any fold PR having touched `archive.md`/README — and no fold PR goes Dirty on them.

## Related
[[fold-build-batching]] · [[spec-lifecycle-and-archival]] · [[../archive]] · [[roadmap-build-console]] · [[../inngest/slack-roadmap-notify]] · [[../project-management]]
