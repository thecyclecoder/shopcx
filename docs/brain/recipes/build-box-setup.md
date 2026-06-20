# Recipe: the self-hosted build box

The box that runs autonomous spec builds on the **Max subscription** for the [[../specs/roadmap-build-console]] (the "do it" button). Reachable only over Tailscale. This page is the reproducible runbook + the day-to-day ops.

## What it is

- **Hetzner CCX33** — Ubuntu 26.04, 8 vCPU, 30 GiB RAM, name `claude-server`. Public IPv4 `178.156.246.235` (firewalled), tailnet IP `100.75.99.7`.
- Runs `systemd` service **`shopcx-builder`** = `scripts/builder-worker.ts`, which polls [[../tables/agent_jobs]], claims a job via `claim_agent_job()`, runs `claude -p` (Max), tsc-gates, and opens a `claude/*` PR. See [[../dashboard/branches]] to merge.

## Core invariants

- **Max billing.** Builds run `env -u ANTHROPIC_API_KEY claude -p …`. The box must have **no `ANTHROPIC_API_KEY`** in the environment — `/root/shopcx/.env.local` keeps it commented out. Claude is logged in as the **Max** account (`dylan@superfoodscompany.com`); creds live in `/root/.claude`. Verify: claude.ai/settings/usage moves, the API console stays flat.
- **No inbound.** The box only reaches *out* (to Supabase + GitHub). Public SSH (:22) is firewalled; the trigger is a DB row the worker polls, never an HTTP call in.
- **One worker.** Only the `shopcx-builder` service runs the worker (don't also start a `nohup` copy).

## Day-to-day ops (over the tailnet)

```bash
ssh root@100.75.99.7   # plain ssh, tailnet IP, default ~/.ssh/id_ed25519. NOT `tailscale ssh` (no Tailscale SSH server) and NOT builder@. Live repo = /home/builder/shopcx (git as `sudo -u builder`); /root/shopcx is a STALE clone, ignore it.
systemctl status shopcx-builder          # health
journalctl -u shopcx-builder -f          # live logs
systemctl restart shopcx-builder         # restart
# Manual worker redeploy — RARELY NEEDED now (the worker self-updates when idle, below). Still the
# escape hatch if self-update is wedged. Deploy when the queue is IDLE — a restart kills in-flight lanes:
sudo -u builder git -C /home/builder/shopcx fetch origin && sudo -u builder git -C /home/builder/shopcx reset --hard origin/main && systemctl restart shopcx-builder
```

## Worker self-update (worker-self-update, shipped 2026-06-19)

The worker keeps **its own code** current — a merged worker fix goes live within one idle cycle, **zero manual redeploy** (closes the gap that left #77's `markReady` fix inert until a human ran the command above, so PRs kept coming out draft).

- **Idle self-update loop.** Each poll tick, **only when `active.size === 0`** (no build/fold lane — in-flight work is sacrosanct), the worker `git fetch origin main` and compares local `HEAD` to `origin/main`. If behind: `git reset --hard origin/main`, `npm ci` **if `package-lock.json` changed**, then `process.exit(0)` — `systemd Restart=always` relaunches on the fresh `builder-worker.ts`. A clean exit + restart is the safe re-exec (never hot-reload in-process). Worktrees live in the sibling `/home/builder/builds/`, so resetting the main repo never touches a running build. The journal logs the `from→to` short SHA.
- **No thrash.** Self-update only fires when `HEAD != origin/main`, at most once per `SELF_UPDATE_MIN_INTERVAL_MS` (60s).
- **Crash-loop guard.** A per-SHA startup counter persists in `/home/builder/.worker-startup.json`. If a freshly-pulled worker keeps dying on startup (same SHA, ≥ `CRASH_LOOP_MAX = 3`), it writes a `needs_attention` [[../tables/worker_heartbeats|heartbeat]] (the breadcrumb) and `exit(1)`s so systemd's `StartLimit` stops the flapping instead of churning a broken commit. The counter zeroes on the first clean poll tick. **Falls back to manual redeploy** (above).
- **Heartbeat.** Every tick the worker upserts [[../tables/worker_heartbeats]] (running SHA · `active_builds` · `last_poll_at`); [[../dashboard/branches]] shows a **Build box** banner so "is the box behind?" is answerable from the UI.

**Required systemd config for the crash-loop guard** (in `/etc/systemd/system/shopcx-builder.service`): `Restart=always` (relaunch on the self-update `exit(0)`) **plus** a start-limit so a flapping worker is eventually parked rather than restarted forever:

```ini
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5
[Service]
Restart=always
RestartSec=5
```

**Bootstrapping:** self-update ships in `builder-worker.ts` itself, so the **one last manual redeploy** (the command above) activates it; every redeploy after that is automatic.

## Provisioning (how it was built — to reproduce)

1. **Tailscale.** `curl -fsSL https://tailscale.com/install.sh | sh` → `tailscale up` (authorize in the admin console). Put the Mac + phone on the same tailnet (`dylanralston@gmail.com`).
2. **Lock down SSH** (run over the tailnet so you can't lock yourself out): `ufw default deny incoming; ufw default allow outgoing; ufw allow in on tailscale0; ufw allow 41641/udp; ufw --force enable`. Confirm public :22 times out and tailnet SSH still works **before** trusting it.
3. **Stack.** Node 24 (`curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`), `build-essential`, Claude Code (`npm i -g @anthropic-ai/claude-code`), `npm i -g tsx`.
4. **Auth Claude → Max.** `claude` → `/login` → sign in with the Max account. Creds persist in `/root/.claude`. **Do not** set `ANTHROPIC_API_KEY`.
5. **Repo + secrets.** Clone with a token (`git clone https://x-access-token:$GITHUB_TOKEN@github.com/thecyclecoder/shopcx.git /root/shopcx`), `npm install`, drop in `.env.local` (prod secrets + `GITHUB_TOKEN`) **with `ANTHROPIC_API_KEY` commented out**.
6. **Service.** `/etc/systemd/system/shopcx-builder.service` → `ExecStart=/usr/bin/tsx scripts/builder-worker.ts`, `WorkingDirectory=/root/shopcx`, `Environment=HOME=/root`, `Restart=always`, **plus `StartLimitIntervalSec=300` / `StartLimitBurst=5`** (so the self-update crash-loop guard can park a flapping worker — see § Worker self-update). Then `systemctl enable --now shopcx-builder`.

## Gotchas (learned in the live bring-up 2026-06-18)

- **A fresh box has no git identity** → `git commit` silently fails → empty branch → GitHub rejects the PR ("No commits between…"). The worker now sets a repo-local identity itself (`ensureGitIdentity`) and fails loudly on commit/push/PR errors.
- **`tsx` wasn't installed** → the worker was fetched via `npx` each boot. Installed globally so `systemd` runs it reliably.
- **`pkill -f builder-worker.ts` matches its own shell** (the pattern is in the command's argv) — kill by process group / pidfile, or let `systemd` manage it.

## Non-root builder + sandboxed builds (build-approval-gates, 2026-06-18)

`shopcx-builder` now runs as the **non-root `builder` user** from `/home/builder/shopcx` (its own clone + `/home/builder/.claude` Max login), so builds run `--dangerously-skip-permissions` (refused as root) with no per-tool prompts. Prod stays safe via two secret stores:
- **`/root/shopcx-worker.env`** (root-only `0600`, systemd `EnvironmentFile=`) holds the worker's prod creds (Supabase service role, DB password, `GITHUB_TOKEN`, …); systemd injects them into the worker process.
- The builder repo has **no `.env.local`**, and the worker **strips secrets from the spawned build's env** (`SECRET_RE` in `builder-worker.ts`) — so the `claude -p` build can't reach prod. The worker (which holds the creds) executes only **owner-approved** gated actions.

Update worker code: `sudo -u builder git -C /home/builder/shopcx fetch origin && git reset --hard origin/main && systemctl restart shopcx-builder`.

## Parallel builds — 5 worktree-isolated lanes (parallel-builds, shipped 2026-06-18)

The worker runs **up to `MAX_CONCURRENT = 5` builds at once**, each in its own **git worktree** under `/home/builder/builds/{job-id}` (isolated dir + branch) so concurrent builds never clobber each other. The pool claims (`claim_agent_job()`) up to 5 jobs per poll tick and tops up as lanes free; a resume recreates a worktree on the job's pushed branch, and every worktree is torn down (`git worktree remove --force`) on any outcome. Cap = **5** because the real ceiling is **Max rate limits**, not the 8-core box (tune `MAX_CONCURRENT`).

**Three gotchas that bit us in bring-up (permanent notes):**
- **Async exec is mandatory.** `runClaude` / `tsc` / approved-action `bash` use `shAsync` (`spawn`, non-blocking), **not `spawnSync`**. `spawnSync` blocks Node's event loop for the *entire* (up to 30-min) build → the 5-lane pool silently collapses to ~1 real lane. Any new long-running step must use `shAsync`.
- **`node_modules` is gitignored** → absent in a fresh worktree → `tsc` fails. The worker force-symlinks the main clone's `node_modules` into each worktree (`ln -sfn`).
- **`.env.local` is absent on the box** (secrets come from the `EnvironmentFile`) → an apply-script that hard-reads it crashes with ENOENT and the migration silently "fails" through the approval gate. The `write-migration` skill now guards the read (`existsSync`) + falls back to `process.env`.
- **Draft-PR trap:** a build that paused (needs_input/needs_approval) opens its PR as a **draft**; on completion the worker now calls `markReady` (GraphQL `markPullRequestReadyForReview`) or it stays unmergeable.

**Separate per-kind lanes (beyond the 5-lane build pool):** `MAX_FOLD = 1` (fold-builds), `MAX_SEED = 2` (product-seeds), and `MAX_SPEC_CHAT = 1` (box-spec-chat authoring-chat turns). Each is filled by its own `claim_agent_job(['<kind>'])` call before the build/plan pool, and excluded from the build-pool count, so an interactive chat turn or a long seed never steals a feature-build lane (and vice-versa). The **spec-chat** lane ([[../specs/box-spec-chat]]) runs each authoring-chat turn as a resumable `claude -p` on Max in a **stable per-chat worktree** (`builds/spec-chat-{chat_id}`, recreated on `origin/main` each turn) — stable because `claude --resume` is cwd-scoped; concurrency-1 keeps two turns of the same chat off the same dir.

**Recovery / fleet ops:** [[manage-the-build-queue]] (`queue-control`) — pause by stopping the worker, `reset-all` to a clean slate, `requeue-stale` after a restart orphans in-flight lanes.

## Related

[[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../specs/worker-self-update]] · [[../specs/box-spec-chat]] · [[../tables/agent_jobs]] · [[../tables/worker_heartbeats]] · [[../dashboard/branches]] · [[../dashboard/roadmap]] · [[write-a-migration-apply-script]]
