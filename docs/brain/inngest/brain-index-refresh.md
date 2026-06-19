# inngest/brain-index-refresh

The **single writer** that keeps the two aggregate brain files fresh out-of-band, so no fold PR ever contends on them. Folds write only the per-spec [[../archive|`archive.d/{slug}.md`]]; this cron regenerates `docs/brain/archive.md` (the Index) and `docs/brain/README.md` folder counts and commits a real diff to `main`. See [[../specs/fold-build-batching]] + [[../project-management]].

**File:** `src/lib/inngest/brain-index-refresh.ts`

## Functions

### `brain-index-refresh`
- **Triggers:** cron `0 9 * * *` (daily) **+** event `brain/index.refresh` (Phase 3 — fired after a `claude/fold-*` PR merges, for near-real-time freshness). **Retries:** 1.
- **Regenerates** from the bundled `docs/brain/` tree via [[../libraries/brain-index]]`.regenerateBrainIndex(process.cwd()/docs/brain)`.
- **Commits** each changed file to `main` via the GitHub Contents API (`PUT /repos/{repo}/contents/{path}`, branch `main`, message `chore: refresh brain index`) — the same path the authoring chat uses. One Inngest `step` per file (independently retryable).
- **No-op / no-loop guard:** diffs the regenerated content against the **live `main`** content (GET sha + decode), and commits only on a real difference. The commit makes `main` equal to regen output, so the next run finds no diff — no empty commits, no CI loop.
- Returns `{ skipped }` when no GitHub token is configured.

## Events

- **Listens:** `brain/index.refresh` (sent by [[../libraries/roadmap-actions]]`.mergeClaudePr` after a `claude/fold-*` merge).
- **Sends:** none.

## Tables written / read

- None. Operates on the repo files (bundled `docs/brain/`) + the GitHub API.

## Gotchas

- **Single-writer invariant:** only this function commits `archive.md` / README counts. Folds (and everything else) must never write them — that's the whole point ([[../specs/fold-build-batching]]). Enforced by convention.
- Reads the **bundled** tree (main as of the last deploy). A merged fold redeploys Vercel, so the daily run — and the post-merge event — see the latest `archive.d/`. The ~1–2 min window where main is ahead of the running deploy self-heals on the next run.
- Needs the whole brain traced into the `/api/inngest` bundle (README counts every folder, archive.md reads `archive.d/`): `next.config.ts` traces `./docs/brain/**/*.md` for `/api/inngest`.
- GitHub token: `GITHUB_TOKEN` or `AGENT_TODO_GITHUB_TOKEN` (same as the authoring chat / merge actions).

## Related

[[../libraries/brain-index]] · [[../libraries/roadmap-actions]] · [[../specs/fold-build-batching]] · [[../archive]] · [[../integrations/inngest]] · [[../project-management]] · [[../lifecycles/roadmap-build-console]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
