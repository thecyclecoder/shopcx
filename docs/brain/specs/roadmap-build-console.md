# Roadmap Build Console — describe → spec → autonomous build → merge, all from the web app ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

> **🔒 CORE INVARIANTS**
> 1. **Max-billing.** Builds run as `env -u ANTHROPIC_API_KEY claude -p …` on the build box. The box's shell env and repo `.env.local` must **never** expose `ANTHROPIC_API_KEY` — auth precedence would silently flip builds to metered API. Claude is authed to **Max** via `~/.claude` on the box (verified: headless `claude -p` runs with no API key present).
> 2. **Box, not a routine.** A routine is itself a `claude` session (`CLAUDECODE=1`), so it can't spawn `claude -p` (nested-session guard). The **self-hosted box runs `claude` as the top-level process**, so `claude -p` is valid there. This is why the executor is a box + worker, not a Claude Code Routine.

A phone-first console on the dashboard that closes the loop from *idea* to *merged PR* without a laptop or a terminal. Three surfaces over infrastructure we already have ([[../lifecycles/agent-todo-system]]): a **roadmap board** that reads the brain and shows what's planned / in progress / shipped; a **spec-authoring chat** where you talk a feature through with Opus until you love it, and it writes `docs/brain/specs/{slug}.md` + queues a build; and a **build dispatcher** that runs the spec autonomously on your **Max subscription** (via a self-hosted Ubuntu box + a `systemd` worker) and opens a `claude/*` PR you squash-merge from `/dashboard/branches`.

**Business outcome:** Dylan can stand up new work from anywhere ("on the pickleball court") — describe a feature on his phone, refine the spec in chat, tap *build*, answer any questions the build raises, and merge the resulting PR — with Dylan-level judgment preserved at the spec-approval, mid-build-question, and PR-merge gates.

## Billing model

- **Spec-authoring chat → Anthropic API (Opus).** Interactive in-app chat; the app backend calls Opus (direct or via Vercel AI Gateway). Cheap conversation tokens. The *only* sanctioned API spend.
- **Spec execution / build → Max subscription.** The box runs `claude -p` as a headless session, Max-billed because no `ANTHROPIC_API_KEY` is present. Answering a build's mid-flight questions is plain text typed in the web app → **no LLM, no token cost**; only the resumed build run costs Max.

## Infra — the build box (provisioned 2026-06-17)

- **Hetzner CCX33** — Ubuntu 26.04, 8 vCPU, 30 GiB RAM, 240 GB disk. Hostname `claude-server`.
- **Network:** Tailscale-only. Tailnet IP `100.75.99.7` (tailnet `dylanralston@gmail.com`); public SSH (port 22 on the public IP) **firewalled off** via `ufw` (allow `tailscale0` + outbound only). The box reaches *out* to Supabase/GitHub; nothing reaches *in* except over the tailnet.
- **Stack:** Node 24, Claude Code 2.1.179, build-essential. Repo cloned at `/root/shopcx` (`main`); `node_modules` installed; `tsc` available.
- **Secrets:** `/root/shopcx/.env.local` carries prod secrets + `GITHUB_TOKEN`, with **`ANTHROPIC_API_KEY` commented out** (so a stray `source .env.local` can't flip billing).
- **Auth:** Claude logged in to **Max** (`dylan@superfoodscompany.com`); creds persist in `/root/.claude`.

## What already exists (reuse, don't rebuild)

- **`agent_todos`** approval queue ([[../tables/agent_todos]]) — `source='manual'`, `payload` jsonb, owner-only approval, drift, group_id. (The new `agent_jobs` queue mirrors this shape.)
- **`/dashboard/branches`** ([[../dashboard/branches]]) — every open `claude/*` PR with CI status + mergeability + **owner squash-merge from the dashboard** (phone-friendly). `POST /api/branches/[number]/merge`.
- **Brain spec convention** ([[../project-management]]) — `docs/brain/specs/{slug}.md` with `⏳ 🚧 ✅`; `specs/README.md` index.
- **P0 skills** (`.claude/skills/`, [[repo-skills-catalog]]) — `build-spec`, `probe-db`, `write-migration`, `customer-remedy`. The worker invokes the **`build-spec`** skill.

---

## Phase 1 — Roadmap board (read-only) ✅

- ⏳ Route `src/app/dashboard/roadmap/page.tsx` (+ sidebar link). Server component.
- ⏳ Parser: read `docs/brain/specs/*.md` + `specs/README.md`; extract `⏳ / 🚧 / ✅` against `## Phase`/heading/bullet lines; also read the `## Status / open work` block from `lifecycles/*.md`. (Markdown is the source of truth — never drifts.)
- ⏳ Three columns — **Planned / In progress / Shipped** — grouped by project track. Each card = a spec; expand to its phases + live build status.
- ⏳ Runtime file access on Vercel: trace `docs/brain/**` into the function bundle (or parse at build time).

## Phase 2 — Spec-authoring chat (Opus via API) ✅

- ⏳ Chat UI on `/dashboard/roadmap` ("New feature" → conversational panel). Phone-first.
- ⏳ Backend `POST /api/roadmap/chat` streams Opus (Anthropic API / Vercel AI Gateway). System prompt loads the spec template ([[../project-management]] § Writing a spec) + brain context so the spec is grounded in real tables/libs.
- ⏳ "Finalize" → model produces the full spec markdown. App (a) commits `docs/brain/specs/{slug}.md` to a `claude/*` branch via GitHub REST, (b) inserts an `agent_jobs` row (`status='queued'`).
- ⏳ New spec shows on the board as ⏳ planned immediately.

## Phase 3 — `agent_jobs` queue + dispatch ✅

The bridge from an on-demand phone tap to the (tailnet-only, no-inbound) box. The box can't be reached from Vercel, so the box reaches **out** to this queue.

- ⏳ New `agent_jobs` table: `id, spec_slug, spec_branch, instructions, status (queued|claimed|building|needs_input|queued_resume|completed|failed|needs_attention), claude_session_id, questions jsonb, answers jsonb, pr_url, log_tail, claimed_at, updated_at`. Migration via the `write-migration` skill. RLS: members read, service role writes.
- ⏳ Board **"Build"** button → owner-gated → inserts/updates an `agent_jobs` row to `status='queued'`. (No inbound call to the box — just a DB write.)
- ⏳ Status + PR url surface on the board card by reading the job row (poll, simplest for v1).

## Phase 4 — Build box + `systemd` worker (the executor) ✅

- ⏳ A `systemd` service `shopcx-builder.service` on the box runs a **worker loop** (a Node/tsx script): poll Supabase every few seconds (or Supabase Realtime) for `status='queued'` / `'queued_resume'`, **atomically claim** one, run the build, write status back. Always-on → survives reboots/disconnects (this is the "session persistence" — **no tmux needed**).
- ⏳ A fresh build runs:
  ```bash
  cd /root/shopcx && git fetch origin && git checkout -B claude/<slug>-<ts> origin/main
  env -u ANTHROPIC_API_KEY claude -p "Use the build-spec skill on docs/brain/specs/<slug>.md" \
    --permission-mode acceptEdits --output-format stream-json
  ```
- ⏳ Worker parses the `stream-json` stream for: the `claude_session_id` (store it — needed for resume), terminal status, and any structured questions block (Phase 5). The `build-spec` skill opens the `claude/*` PR via GitHub REST with the token in `.env.local`.
- ⏳ Concurrency 1–2 to start (8 cores can do more, but **Max rate limits** are the real ceiling). `--max-turns` + a wall-clock timeout guard runaway → `needs_attention` with `log_tail`.

## Phase 5 — Build feedback / questions loop ✅ (the answer to "builds have questions")

A build is a **multi-turn conversation spread across separate headless invocations.** The `agent_jobs` row carries questions/answers between turns; Claude's **on-disk transcript** (`~/.claude/projects/`) carries the context. The worker is the durable process; the *job* waits, never a live process — so no tmux, no held-open SSH.

**When a build hits a decision the spec doesn't cover, it does NOT guess. It:**
1. Commits its partial work to the branch and opens (or leaves) the PR as **draft** — progress is never lost.
2. Emits a structured block as the last thing in its response (the `build-spec` skill instructs this): a fenced ```json {"status":"needs_input","questions":[{"id","q","options?"}]}```.
3. The worker parses that, writes `questions` + `claude_session_id` to the job row, mirrors the questions into the PR's `## ⏳ Open questions` section, sets `status='needs_input'`, and exits the invocation.

**Answering (phone-friendly, zero token cost):**
4. The web app surfaces the questions on the board card / a lightweight chat thread (+ optional push notification). Dylan types answers → written to `agent_jobs.answers`, `status='queued_resume'`. No LLM involved.
5. The worker picks up `queued_resume` and resumes the *same* session:
   ```bash
   env -u ANTHROPIC_API_KEY claude --resume <claude_session_id> -p "Answers to your open questions: <answers>"
   ```
   Claude continues with full prior context (transcript on disk, survives reboots), incorporates the answers, and either finishes (`completed`, PR marked ready) or raises more questions (`needs_input` again). **Loop until `completed`.**

This is the same conversational pattern as the Phase-2 authoring chat, just at execution time. (Future: a custom `request_input` MCP tool would be cleaner than the JSON-block convention, but the convention needs zero extra infra.)

## Phase 6 — Review + merge from phone ✅

- ✅ (exists) `/dashboard/branches` lists the `claude/*` PR with CI status + mergeability; owner **Squash & merge** works from the phone. Confirm `spec_build` PRs surface (head ref is `claude/*` → they do).
- ⏳ Cross-link the board card → its PR; only show "ready to merge" once the job is `completed` (PR un-drafted).

## Safety / invariants

- **Max-billing:** builds run `env -u ANTHROPIC_API_KEY claude -p …`; the box env + `.env.local` never expose `ANTHROPIC_API_KEY`. Verify via claude.ai/settings/usage (should move) vs the API console (flat).
- **No inbound to the box:** the trigger is always a DB write the worker polls — never an HTTP call into the box (it's tailnet-only, no public port).
- **Never block, never guess:** each build invocation terminates ("done" / "needs_input" / "failed"); the job waits, not a process. On a real decision it surfaces a question, it does not guess. Partial work is committed before pausing.
- **Human gates preserved:** Build is owner-gated; PRs **never auto-merge**; merge to main is an owner click on `/dashboard/branches` with server-side re-validation.
- **CI gate:** `npx tsc --noEmit` before any PR opens (in the `build-spec` skill). No broken PR reaches the branches surface.
- **Resume integrity:** resume targets the stored `claude_session_id` so context is intact across reboots; transcripts on disk are the source of session truth.
- **Brain discipline:** the spec is the contract; the build folds new concepts into brain pages in the same PR.
- **One active build per spec.**

## Completion criteria

- From a phone: open `/dashboard/roadmap`, see Planned/In-progress/Shipped from the brain.
- Describe a feature in chat → finalize → a real `docs/brain/specs/{slug}.md` on a `claude/*` branch + a `queued` `agent_jobs` row.
- Tap Build → the box worker implements it on **Max** (API console flat, Max usage moves) → CI-passing `claude/*` PR on `/dashboard/branches`.
- A build that raises a question surfaces it on the phone; answering it resumes the same session and the build finishes.
- Squash-merge from the phone. Spec phase emojis reflect reality throughout.

## Open questions

- **Poll vs Realtime** for the worker: poll (simplest, a few-sec latency — fine for pickleball) vs Supabase Realtime (instant). Start with poll.
- **Question UX surface:** board-card thread vs a dedicated chat panel vs PR comments. Leaning board-card thread (phone-first) + mirror to PR for the record.
- **Structured-questions mechanism:** JSON-block convention (v1, zero infra) vs a `request_input` MCP tool (cleaner, later).
- **Concurrency vs Max rate limits:** start at 1–2; measure before raising.
- **`.git/config` token:** the clone embedded the token in the remote URL — acceptable on a locked box; consider a credential helper later.

## Verification
- On a phone, open `/dashboard/roadmap` → expect **Planned / In progress / Shipped — awaiting verification** columns rendered from `docs/brain/specs/*.md`.
- Tap **New feature**, describe something in the Opus chat, tap **Save & build** → expect a `docs/brain/specs/{slug}.md` committed and a `queued` `agent_jobs` row; the spec appears as ⏳ on the board.
- Tap **Build** on a spec → expect the box worker to implement it on **Max** (Anthropic API console stays flat, Max usage moves) and a CI-passing `claude/*` PR to appear on `/dashboard/branches`.
- Make a build raise a question → expect a **Needs input** chip + **Answer** affordance on the card; answer it → the same `claude_session_id` resumes and the build finishes → **Squash & merge** from the card merges it.

## Related

[[repo-skills-catalog]] · [[../lifecycles/agent-todo-system]] · [[../tables/agent_todos]] · [[../dashboard/branches]] · [[../project-management]] · [[README]]
