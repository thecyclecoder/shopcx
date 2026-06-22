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

## Startup orphan-reaper (worker-orphan-reaper, shipped 2026-06)

A restart — self-update (`git reset --hard origin/main` + `exit(0)`), deploy, or crash — abandons any job the old instance had **in flight** (`building`/`claimed`/`queued_resume`). The new worker only claims `queued`, so those rows sit in `building` **forever**, never completing and tripping the Control Tower's "N jobs stuck in building past 60m" alert (observed live: 7 spec-test jobs piled up across several deploys in one session). So **`reapOrphans()` runs in `main()` before the poll loop** — best-effort (wrapped so a reaper failure never blocks startup), idempotent (a clean boot with nothing orphaned is a no-op), and **cutoff-gated**: it only touches jobs `claimed_at < WORKER_STARTED_AT` (the heartbeat `started_at`), so nothing the *current* instance owns is ever mid-build-killed.

Reap is **by kind**:
- **Re-runnable / idempotent kinds** — `RERUNNABLE_KINDS` = `spec-test`, `triage-escalations`, `migration-fix`, `dev-ask`, `pr-resolve` → **reset to `queued`** (clear `claimed_at`) so they simply re-run. No work lost.
- **Work-producing kinds** — `build`, `plan`, `fold`, `product-seed`, `spec-chat`, `ticket-improve` → **mark `failed`** with `error="orphaned by worker restart"` (NOT re-queued — a restart may have left a half-pushed branch, and a blind re-run could double-push). The failed-builds callout on [[../dashboard/roadmap]] then surfaces it; if a branch *was* pushed, [[build-recover-pr-create]]'s **Create PR** recovers the completed work — no rebuild.
- Logs the reap counts by kind (`[reaper] reaped N orphan(s) … re-queued: …; failed: …`, or `0 reaped — no orphaned in-flight jobs from a previous instance` on a clean boot) so a restart's cleanup is visible, not silent.

`RERUNNABLE_KINDS` is the **single shared source of truth** — the self-update `sacrosanctActive` check (lanes a restart may interrupt) reads the same constant, so "safe to re-run" can't drift between reaper and self-update. No migration (free-text `kind`, existing [[../tables/agent_jobs]] columns). This is the standing replacement for the manual `requeue-stale` ([[manage-the-build-queue]]) after a restart, and removes the stuck-jobs false-positive source the [[../dashboard/control-tower]] flagged.

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

**Interactive Max lanes (no PR).** Beyond the 5 build/plan worktree lanes + the concurrency-1 fold lane, the worker fills five more dedicated lanes each poll tick: `['product-seed']` (`MAX_SEED=2`, [[../specs/box-product-seeding]]), `['ticket-improve']` (`MAX_TICKET_IMPROVE=1`, [[../specs/box-ticket-improve]] — one resumable Max turn per ticket, reads brain/`src/` in the main checkout read-only, never mutates / opens a PR), `['triage-escalations']` (`MAX_TRIAGE=1`, [[../specs/box-escalation-triage]] — the hourly escalation sweep, `runEscalationTriageJob`), `['spec-test']` (`MAX_SPEC_TEST=1`, [[../specs/spec-test-agent]] — the daily QA pass over one shipped-but-unverified spec, `runSpecTestJob`, in the main checkout read-only), and `['migration-fix']` (`MAX_MIGRATION_FIX=1`, [[../specs/migration-fix-agent]] — `runMigrationFixJob`, in the main checkout, diagnoses a failed migration read-only then proposes a gated billing repair). All run as top-level `claude -p` on Max (`ANTHROPIC_API_KEY` unset) and keep the DB/crypto secrets so their deterministic CLI tools can reach prod — product-seed writes; ticket-improve only reads (via `scripts/improve-box-tools.ts`) and spec-test only reads (via `scripts/spec-test-db-probe.ts`, `gh`, `vercel`, GET hits); **migration-fix reads for the diagnosis but its mutations are gated to the server-side approval path** (the worker runs [[../libraries/migration-fix]] `applyMigrationFix` only on owner approval), with any mutation gated to the server-side approval path.

**Event-fired dirty-PR resolve (dirty-pr-resolver-agent).** Also an **event, not a cron**: the [[../integrations/github-webhook|GitHub webhook]] (`POST /api/webhooks/github`, on a `push` to `main` / a `pull_request` event) detects a dirty (`CONFLICTING`) `claude/*` build PR via [[../libraries/github-pr-resolve]] and enqueues a `kind='pr-resolve'` [[../tables/agent_jobs]] job. The worker claims it on its **concurrency-1 `MAX_PR_RESOLVE=1` lane** (`runPrResolveJob`) and — UNLIKE the read-only Max lanes above — **does use a throwaway worktree** (`builds/{job-id}` on the PR branch): a `claude -p` on Max (git available, prod secrets stripped — **no prod creds, and `GITHUB_TOKEN` stripped so the LLM can't push**) runs `git merge origin/main` + resolves the (usually additive) conflicts. The **worker** then enforces the gate deterministically — `git merge-base --is-ancestor origin/main HEAD` (the merge really happened) · no `git ls-files -u` (no unmerged paths) · no leftover conflict markers · **`npx tsc --noEmit`** — and only then `git push`es → the PR flips `CONFLICTING → MERGEABLE`. On a heavy parallel-rewrite divergence or a merge that can't compile it does NOT force a wrong merge: it **rebuilds-on-main** (close the PR + re-queue the originating `build` off a clean `main`, deduped) or — if it can't identify the spec — **surfaces** "PR #N needs a human merge: {why}" via [[../libraries/notify-ops-alert]] (job → `needs_attention`). Capped, idempotent, deduped (one resolve per PR). `claude/*` branches ONLY — never a human PR or `main`. No PR of its own.

**Event-fired Repair Agent (repair-agent).** Also an **event, not a cron**: the moment the Control Tower records a NEW problem ([[../libraries/control-tower]] `recordError` on a new [[../tables/error_events]] signature, or `runControlTowerMonitor` on a newly-opened [[../tables/loop_alerts]]), [[../libraries/repair-agent]] `enqueueRepairJob` inserts a `kind='repair'` [[../tables/agent_jobs]] job (deduped by signature). The worker claims it on its **`MAX_REPAIR` (default 2) lane** (`runRepairJob`, main checkout read-only) and runs a `claude -p` on Max (web search on, no `ANTHROPIC_API_KEY`, keeps read-only DB/crypto secrets): INVESTIGATE the signature read-only → CLASSIFY (`real-bug`/`monitor-false-positive`/`foreign-app-noise`/`transient`/`needs-human`) → ACT — author a single-phase fix spec to main + **surface** it for one-tap owner Build (`needs_approval` + a `repair_build` `pending_actions` entry, actioned via `POST /api/developer/control-tower/repair`), or **auto-queue** the build for a narrow mechanical allow-list (`REPAIR_AUTOBUILD_KINDS` = foreign-app-noise + monitor-false-positive), or no-op-**resolve** a transient error row, or **surface needs-human** (`needs_attention`). Surface-don't-auto-build (North star): it NEVER edits product code / opens a PR / applies a migration — building stays owner-gated. No PR of its own; deduped by signature.

**Event-fired migration-fix (migration-fix-agent, shipped 2026-06-20).** UNLIKE the cron-enqueued spec-test/triage lanes, the migration-fix lane is fired by an **event, not a cron**: [[../libraries/migration-audit]] `verifyMigration` enqueues a `kind='migration-fix'` [[../tables/agent_jobs]] job the moment a [[../tables/migration_audits]] row transitions to `failed` (a renewal at risk). The worker claims it on the **concurrency-1 `MAX_MIGRATION_FIX=1` lane** and runs the `migration-fix` skill: diagnose the failing checks read-only over a baked-in brief (audit + sub + catalog + engine pricing + the live Appstle contract) → propose a typed fix (`price_reconcile`/`variant_backfill`/`appstle_cancel`) parked in `pending_actions`. The owner approves on [[../dashboard/migrations]] (`/api/roadmap/approve` → `queued_resume`); the worker executes via [[../libraries/migration-fix]] `applyMigrationFix` then re-runs `verifyMigration` — only a re-`passed` clears the row; unfixable (no billable card) stays `failed` with the box's written diagnosis. No PR.

**Daily spec-test QA (spec-test-agent, shipped 2026-06-20).** Like triage, an **Inngest cron enqueues the sweep**: `spec-test-cron` ([[../inngest/spec-test-cron]], `45 10 * * *`, concurrency-1) inserts one `kind='spec-test'` [[../tables/agent_jobs]] row per shipped-but-not-archived spec (`deriveStatus==shipped` AND no `archive.d/{slug}.md`), per build-console workspace, deduped against an in-flight job or a fresh (<20h) run. The worker claims each on the **concurrency-1 `MAX_SPEC_TEST=1` lane** and runs the `spec-test` skill — classify each `## Verification` bullet (auto / needs-human / mutating→needs-human) and run only the **non-destructive** checks (repo/`tsc`, `gh` CI, `vercel` deploy+logs+env, read-only DB probes via `scripts/spec-test-db-probe.ts`, GET endpoints) — writing one [[../tables/spec_test_runs]] row with an `agent_verdict` stamp. **No PR; never mutates prod; never marks a spec verified/archived** (that owner-only gate stays untouched). Surfaced on **Developer → Spec Tests**, the board card chip, and the spec's VerificationCard.

**Vercel CLI provisioning (spec-test-agent).** The spec-test agent needs the **`vercel` CLI** + a **read-scoped `VERCEL_TOKEN`** to confirm the deploy is READY, read build/runtime logs, and check `vercel env ls`. Install on the box (`npm i -g vercel`) and add `VERCEL_TOKEN` to the worker env (`/root/shopcx-worker.env`, the systemd `EnvironmentFile`) — **owner op** (token minting is the owner's; surface it as a gated action if missing). `gh`/`GITHUB_TOKEN` are already present. If `vercel`/`VERCEL_TOKEN` is absent the agent degrades gracefully: it marks Vercel-dependent bullets `inconclusive` (with that reason) rather than failing them.

**Playwright / chromium provisioning (spec-test-deep-verification Phase 1).** The spec-test agent's **headless-browser check** (`scripts/spec-test-browser-check.ts`) needs the chromium browser binary + its system libs. Provision it on the box **as root** (owner op): `npx playwright install --with-deps chromium`. The `playwright` npm package is in `package.json` (picked up by the worker's `npm ci` on self-update), so only the browser/system-deps install is a manual root step — run it once (and after a major Playwright bump). No new token: the tool mints the **owner Supabase session server-side** from the service-role key already in the worker env (no human creds). Screenshots land in the private **`spec-test-evidence`** Storage bucket, which the tool creates idempotently on first run (`ensureSpecTestEvidenceBucket`). If chromium is missing, browser-check bullets surface as `inconclusive`/error (the launch throws) rather than passing silently.

**Spec-test sandbox fixtures (spec-test-deep-verification Phase 2).** The spec-test agent's **sandbox check** (`scripts/spec-test-sandbox.ts`) drives INTERNAL-ONLY behavioral flows against a dedicated **`is_test` workspace** + test customer / comp subscription / ticket / migration_audit. Two one-time **gated owner ops** (the box has no prod creds — surface them as `needs_approval` actions): (1) apply the sentinel-column migration — `npx tsx scripts/apply-workspaces-is-test-migration.ts` (adds [[../tables/workspaces]] `is_test`, idempotent); (2) seed the fixtures — `npx tsx scripts/seed-spec-test-fixtures.ts` (idempotent upsert on stable UUIDs; re-runnable, also resets fixtures to baseline). The seed adds the owner as an `owner` `workspace_member` of the test tenant so owner-gated POST flows pass when scoped there, and leaves **all credential columns null** so no external API call can fire. No new token: owner-gated POSTs are driven with a server-side-minted owner session (`mintOwnerCookieHeader`, same mechanism as the browser check). The toolkit refuses any non-`is_test` workspace (`assertTestWorkspace`); see [[../libraries/spec-test-sandbox]]. If the fixtures aren't seeded, sandbox-check bullets surface as `inconclusive`/error (the tool throws "run the fixture seed first") rather than passing silently.

**Hourly escalation triage (triage-escalations, shipped 2026-06-20).** The box has no internal ticker, so an **Inngest cron enqueues the sweep** (the [[../inngest/portal-auto-resume]] precedent): `triage-escalations-cron` ([[../inngest/triage-escalations]], `30 * * * *`, concurrency-1) inserts one `kind='triage-escalations'` [[../tables/agent_jobs]] row per workspace with a routine-owned escalated ticket. The worker claims it on the **concurrency-1 `MAX_TRIAGE=1` lane** and sweeps up to `TRIAGE_CAP` (default 5, env `AGENT_TODO_TRIAGE_CAP`) tickets, running a **solver→skeptic→quorum** loop as 2–4 separate `claude -p` Max sessions per ticket. On quorum it materializes (customer fix → `pending` [[../tables/agent_todos]] · rule → `proposed` [[../tables/sonnet_prompts]] · code/analyzer fix → a `docs/brain/specs/` file committed straight to main); every ticket per sweep gets a [[../tables/triage_runs]] audit row. No PR (specs commit via the Contents API like the planner). This **replaced the retired Anthropic-cloud agent-todo routine** ([[../lifecycles/agent-todo-system]]).

## Related

[[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../specs/worker-self-update]] · [[../specs/box-spec-chat]] · [[../specs/box-escalation-triage]] · [[../tables/agent_jobs]] · [[../tables/triage_runs]] · [[../tables/worker_heartbeats]] · [[../inngest/triage-escalations]] · [[../dashboard/branches]] · [[../dashboard/roadmap]] · [[write-a-migration-apply-script]]
