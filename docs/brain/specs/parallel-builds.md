# Parallel builds — worktree-isolated concurrency (up to 5) ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The box worker ([[../recipes/build-box-setup]]) processes **one build at a time** — it checks out the branch in the single shared repo dir, so concurrent builds would clobber each other. Result: a queued build waits until the active one finishes. Run **up to 5 builds in parallel**, each in its own **git worktree** (isolated dir + branch), so dispatches don't queue behind each other.

**Business outcome:** fire several builds at once (e.g. finish three stalled specs) and they run concurrently — no waiting in line.

## Phase 1 — Worktree isolation ⏳
- ⏳ Each build runs in `git worktree add -B claude/{slug}-{ts} <dir> origin/main` (resume: from `origin/{branch}`) — its own working tree + branch, under a `builds/` sibling dir. All build git/`tsc`/`claude` ops run with `cwd` = the worktree.
- ⏳ **Symlink** the main clone's `node_modules` into each worktree (it's gitignored → absent in a fresh worktree) so `tsc`/builds work without a 1.6 GB re-install.
- ⏳ Tear the worktree down (`git worktree remove --force`) on every terminal/pause outcome — the branch is pushed, so a resume recreates a worktree on it.

## Phase 2 — Concurrency pool (cap 5) ⏳
- ⏳ `builder-worker.ts` keeps a pool of in-flight builds; each poll tick it claims (`claim_agent_job()`) up to `MAX_CONCURRENT = 5`, runs them concurrently (no `await` blocking the loop), and tops up as lanes free.
- ⏳ Cap is **5** — the real ceiling is **Max rate limits** (not the box's 8 cores). Tunable constant.

## Phase 3 — Resume handling ⏳
- ⏳ A paused job (`needs_input`/`needs_approval`) recreates a worktree on its existing pushed branch on resume; `claude --resume` uses the on-disk session id (transcript survives regardless of worktree). Approved gated actions execute in the resumed worktree.

## Safety / invariants
- **Cap = 5** to respect Max rate limits; the box can do more but Max throttles.
- Worktrees always torn down (no leaked checkouts); `git worktree prune` on startup.
- Concurrent **migrations are still human-serialized** by the approval gate (you tap them one at a time).
- Builds stay sandboxed: each worktree is a fresh `origin/main` checkout (no `.env.local`), env still stripped, Max-billed.

## Completion criteria
- Two queued specs build **simultaneously** (verified: queue two, watch both `building` at once → two PRs).
- A resume still works (worktree recreated on the branch).

## Note on delivery
Built via a **direct worker refactor**, not through the box (the worker can't safely rebuild its own core loop while running, and a deploy mid-build kills in-flight work). Redeploy only when the pipeline is idle.

## Related
[[roadmap-build-console]] · [[build-approval-gates]] · [[../recipes/build-box-setup]] · [[../tables/agent_jobs]] · [[../lifecycles/roadmap-build-console]]
