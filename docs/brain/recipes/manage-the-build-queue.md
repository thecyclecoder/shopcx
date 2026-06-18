# Recipe: manage the build queue (`queue-control`)

Break-glass CLI for the `agent_jobs` build queue — the jobs the box worker ([[../recipes/build-box-setup]]) claims and runs. The dashboard ([[../dashboard/roadmap]]) is the normal path (Build / approve / merge); reach for this when you need to **pause the fleet, recover from a bad state, or batch-manage** — e.g. a bad spec is looping, a deploy killed in-flight builds, or you want to stop everything while you fix the worker.

**Tool:** `scripts/queue-control.ts`. Run on the box, or locally with prod creds in `.env.local` (guarded — works either place). Writes go through `createAdminClient()`.

## Commands

| Command | What it does |
|---|---|
| `list` (default) | Active (non-terminal) jobs: `status · spec_slug · PR#`. |
| `queue <slug>` | Queue a build for a spec (same effect as the board's **Build**). |
| `hold` | **Pause:** `queued`/`queued_resume` → `held` (a snapshot is saved to `.queue-snapshot.json`). Worker stops claiming them. |
| `release` | **Resume:** `held` → `queued`. |
| `requeue-stale` | `building`/`claimed` jobs orphaned by a worker restart → `queued` (fresh). |
| `reset-all` | **Clean slate:** every non-terminal job → fresh `queued` (clears session/branch/pending_actions). **Stop the worker first** or you race active lanes. |
| `complete <slug>` | Force a stuck job → `completed` (use when the PR is actually done but the job won't clear). |

## The "pause → fix → resume" play

The reliable way to freeze the fleet for maintenance is to **stop the worker** (hard pause — nothing gets claimed, the queue sits safely in the DB), not to hold rows (which races a busy worker):

```bash
ssh root@<box> 'systemctl stop shopcx-builder'      # hard pause
npx tsx scripts/queue-control.ts reset-all          # (optional) clean slate while stopped
ssh root@<box> 'systemctl start shopcx-builder'      # resume — worker drains the queue (up to 5 lanes)
```

After any restart that killed in-flight builds, `requeue-stale` re-queues the orphans. See [[../lifecycles/roadmap-build-console]] for the worker model + [[build-box-setup]] § Parallel builds for the gotchas (worktrees, `node_modules` symlink, async exec).

## Fold-builds run in their own lane

`kind='fold'` jobs (the batch fold-builds behind "Mark verified & archive", [[../specs/fold-build-batching]]) claim into a **concurrency-1 lane** separate from the 5 build/plan lanes — `claim_agent_job(['fold'])` vs `claim_agent_job(['build','plan'])`. A fold edits the generated index files (`archive.md` / `README.md` counts, via `scripts/brain-index.mjs`), so serializing it keeps the fleet mergeable. The specs a fold will retire live in [[../tables/pending_folds]] (status `pending|folding`), not on the job — `queue-control list` shows the fold job under the `fold-batch` sentinel slug. To clear a stuck fold batch, reset its `pending_folds` rows (`pending`, or `folded` if already done) and force the job via `complete`.

## Related
[[build-box-setup]] · [[../dashboard/roadmap]] · [[../lifecycles/roadmap-build-console]] · [[../tables/agent_jobs]] · [[../tables/pending_folds]] · [[../specs/fold-build-batching]]
