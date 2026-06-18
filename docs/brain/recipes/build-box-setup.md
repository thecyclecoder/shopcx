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
ssh root@100.75.99.7
systemctl status shopcx-builder          # health
journalctl -u shopcx-builder -f          # live logs
systemctl restart shopcx-builder         # restart
# update the worker after merging worker changes to main:
cd /root/shopcx && git checkout main && git pull --ff-only origin main && systemctl restart shopcx-builder
```

## Provisioning (how it was built — to reproduce)

1. **Tailscale.** `curl -fsSL https://tailscale.com/install.sh | sh` → `tailscale up` (authorize in the admin console). Put the Mac + phone on the same tailnet (`dylanralston@gmail.com`).
2. **Lock down SSH** (run over the tailnet so you can't lock yourself out): `ufw default deny incoming; ufw default allow outgoing; ufw allow in on tailscale0; ufw allow 41641/udp; ufw --force enable`. Confirm public :22 times out and tailnet SSH still works **before** trusting it.
3. **Stack.** Node 24 (`curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`), `build-essential`, Claude Code (`npm i -g @anthropic-ai/claude-code`), `npm i -g tsx`.
4. **Auth Claude → Max.** `claude` → `/login` → sign in with the Max account. Creds persist in `/root/.claude`. **Do not** set `ANTHROPIC_API_KEY`.
5. **Repo + secrets.** Clone with a token (`git clone https://x-access-token:$GITHUB_TOKEN@github.com/thecyclecoder/shopcx.git /root/shopcx`), `npm install`, drop in `.env.local` (prod secrets + `GITHUB_TOKEN`) **with `ANTHROPIC_API_KEY` commented out**.
6. **Service.** `/etc/systemd/system/shopcx-builder.service` → `ExecStart=/usr/bin/tsx scripts/builder-worker.ts`, `WorkingDirectory=/root/shopcx`, `Environment=HOME=/root`, `Restart=always`. Then `systemctl enable --now shopcx-builder`.

## Gotchas (learned in the live bring-up 2026-06-18)

- **A fresh box has no git identity** → `git commit` silently fails → empty branch → GitHub rejects the PR ("No commits between…"). The worker now sets a repo-local identity itself (`ensureGitIdentity`) and fails loudly on commit/push/PR errors.
- **`tsx` wasn't installed** → the worker was fetched via `npx` each boot. Installed globally so `systemd` runs it reliably.
- **`pkill -f builder-worker.ts` matches its own shell** (the pattern is in the command's argv) — kill by process group / pidfile, or let `systemd` manage it.

## Non-root builder + sandboxed builds (build-approval-gates, 2026-06-18)

`shopcx-builder` now runs as the **non-root `builder` user** from `/home/builder/shopcx` (its own clone + `/home/builder/.claude` Max login), so builds run `--dangerously-skip-permissions` (refused as root) with no per-tool prompts. Prod stays safe via two secret stores:
- **`/root/shopcx-worker.env`** (root-only `0600`, systemd `EnvironmentFile=`) holds the worker's prod creds (Supabase service role, DB password, `GITHUB_TOKEN`, …); systemd injects them into the worker process.
- The builder repo has **no `.env.local`**, and the worker **strips secrets from the spawned build's env** (`SECRET_RE` in `builder-worker.ts`) — so the `claude -p` build can't reach prod. The worker (which holds the creds) executes only **owner-approved** gated actions.

Update worker code: `sudo -u builder git -C /home/builder/shopcx pull --ff-only origin main && systemctl restart shopcx-builder`.

## Related

[[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../tables/agent_jobs]] · [[../dashboard/branches]] · [[../dashboard/roadmap]] · [[write-a-migration-apply-script]]
