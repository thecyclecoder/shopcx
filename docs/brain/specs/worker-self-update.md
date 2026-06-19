# Worker self-update — the build box redeploys its own code when idle ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The box worker ([[../recipes/build-box-setup]]) runs `scripts/builder-worker.ts` frozen at the last manual redeploy — it does **not** auto-update. Builds always branch from latest `origin/main`, but the **worker process's own code** only changes when a human runs `git reset --hard origin/main && systemctl restart`. So a merged worker fix is **inert until someone remembers to redeploy** — which bit us twice on 2026-06-18/19: [[build-lifecycle-hardening]] (#77) merged but the box kept the old buggy `markReady`, so PRs kept coming out draft. Close the loop: the worker keeps itself current.

**Business outcome:** merge a worker improvement → it's live within one idle cycle, zero manual steps. The last structural gap in "describe → build → merge → it just works."

## Phase 1 — Idle self-update loop ⏳
- ⏳ Each poll tick, **only when `active.size === 0`** (no build/fold lane running — never kill in-flight work): `git -C <REPO_DIR> fetch origin` and compare local `HEAD` to `origin/main`.
- ⏳ If behind, `git reset --hard origin/main`, then **`process.exit(0)`** — `systemd Restart=always` relaunches the worker with the fresh `builder-worker.ts`. (Don't hot-reload in-process; a clean exit + systemd restart is the safe re-exec.) Worktrees live in a sibling dir, so resetting the main repo is safe.
- ⏳ Log the update (`from→to` short SHA) so the journal shows when/what it picked up.

## Phase 2 — Dependency + safety guards ⏳
- ⏳ If `package-lock.json` changed in the pulled diff, run `npm ci` (or `npm install`) **before** the exit so the new code's deps are present.
- ⏳ Crash-loop guard: rely on `systemd` `StartLimitIntervalSec`/`Restart=on-failure` backoff; if the freshly-pulled worker exits non-zero on startup repeatedly, stop + leave a `needs_attention` breadcrumb (an `agent_jobs`/heartbeat row) so a human is alerted instead of silent flapping.
- ⏳ Don't thrash: only update when `HEAD != origin/main` (no-op when current); a short min-interval between self-updates.

## Phase 3 — Heartbeat / visibility ⏳
- ⏳ The worker writes a lightweight heartbeat (running SHA + last-poll time) the dashboard can read, so [[../dashboard/roadmap]] / [[../dashboard/branches]] can show "worker: `<sha>`, healthy Ns ago" — making "is the box behind?" answerable from the UI instead of SSH.

## Safety / invariants
- **Never self-update mid-build** — gate strictly on `active.size === 0`. An in-flight build/fold is sacrosanct.
- Self-update touches only the **worker's own repo dir**, never a running worktree.
- Max billing + sandbox invariants unchanged (still `env -u ANTHROPIC_API_KEY`, secrets stripped).
- This is itself an [[build-lifecycle-hardening|infra change to the worker]] → **serialize** its build; and after it merges, **one last manual redeploy** activates self-update (bootstrapping) — every redeploy after that is automatic.

## Completion criteria
- Merge a change to `scripts/builder-worker.ts` → within one idle cycle the box runs it, with no human redeploy (verify: check the journal shows the `from→to` self-update + the new SHA).
- A build running when a worker change merges is **never interrupted** — the update waits for the lane to clear.
- The dashboard shows the worker's running SHA + health.

## Related
[[roadmap-build-console]] · [[build-lifecycle-hardening]] · [[parallel-builds]] · [[fold-build-batching]] · [[../recipes/build-box-setup]] · [[../lifecycles/roadmap-build-console]] · [[../tables/agent_jobs]]
