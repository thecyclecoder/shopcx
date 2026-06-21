# Developer Message Center ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform" (a read-only investigation/planning sibling of [[box-spec-chat]] and [[goal-decomposition-engine]]; reuses the same box queue + chat machinery)

A founder-facing, read-only "ask the box anything" console under **Developer** that fires a long-running `claude -p` session on the build box with the **whole brain, the full repo, read access to the production database, and web search** at hand — so Dylan can investigate ("does this feature actually work right now?"), pull ad-hoc analysis from the DB ("how many storefront sessions had add-to-carts last week?"), and plan specs against the big-picture goals, all in one resumable thread. It is a **report-back system, not a builder**: it never writes product code and never silently mutates anything — reads are free and silent, but every database write, schema change, or migration stops at an **approval card** that only Dylan's click executes. When it finds a code/capability gap it drafts a spec and hands it off **integrated** (one click into the spec→build pipeline), so investigation flows straight into roadmap work. Outcome: the founder gets a grounded, free-to-run (Max) analyst + planner that turns "I wonder if…" into either an answer or a queued spec, without leaving the dashboard.

## Phase 1 — `dev-ask` job kind + worker runner ✅
- ✅ Add `agent_jobs.kind='dev-ask'` claimed via `claim_agent_job(['dev-ask'])` into its **own concurrency-1 lane** (interactive, serialized; must not starve the build/plan lanes — see [[../tables/agent_jobs]] per-kind pools).
- ✅ `runDeveloperMessageJob(job)` in `scripts/builder-worker.ts`, modeled on `runSpecChatJob` / `runTicketImproveJob`: load the thread, build the prompt (turn 1 = framing + first message; else just the latest user message), run `claude -p` (fresh or `--resume <box_session_id>`) on Max, capture `{reply, status, session_id, pending_actions?}`, write results back, flip turn status.
- ✅ `instructions` JSON = `{thread_id, mode}` where `mode ∈ {turn, approve_action}` (a spec/db-mutation proposal rides a normal `turn`'s `pending_actions` — no separate propose mode; `approve_action` is the deterministic executor turn). `spec_slug` carries the thread id (mirrors spec-chat's reuse of the column as a thread handle).
- ✅ Per-thread git worktree recreated on fresh `origin/main` each turn (so brain/code reads are current); cleaned up in `finally`; node_modules symlinked from the main repo. Concurrency-1 avoids self-update racing an in-flight read.

## Phase 2 — third box `claude` variant: read-only DB + WebSearch ✅
- ✅ Today the box has two session flavors and neither has both: spec-chat (`runClaude`) has **WebSearch** but no DB creds; ticket-improve/triage (`runImproveClaude`) has **DB + crypto secrets** but WebSearch off. Add a third variant for this lane that carries **read-only DB access AND WebSearch on**, still `env -u ANTHROPIC_API_KEY` (Max billing, no per-token spend).
- ✅ DB uses the **existing service-role Supabase key** (`createAdminClient` via the `scripts/_bootstrap.ts` convention) — **no special restricted DB role**. The "read-only" guarantee is enforced by the **approval gate + tool surface**, not by the key (the key can write; we choose not to give a freestyle write path), exactly how [[box-ticket-improve]] and [[migration-fix-agent]] already operate with full creds.
- ✅ Brain + full repo code access come for free from the worktree (`Read`/`Grep`/`Glob` over `docs/brain/` + `src/`), plus `tsc`/grep for "does it work right now?" investigation and read-only probes of recent Inngest runs / error rows.

## Phase 3 — DB query convention + the throwaway-script read path ✅
- ✅ The read path is the natural Claude shape: it writes a **throwaway `scripts/_*.ts` query script** in the worktree that bootstraps `createAdminClient` and runs the select/join/aggregation, executes it, reads stdout, moves on. These scripts live in the per-thread worktree and **are never committed** — scratch, not product code. So "no code" means no committed/product code, not no ephemeral query scripts.
- ✅ Reads are **silent and unprompted** — it never asks permission to SELECT/join/analyze.
- ✅ Write a **brain reference/recipe page** (`docs/brain/recipes/dev-message-center-db.md` or similar) documenting the convention — bootstrap with the service key, SELECT-only discipline, throwaway scripts in the worktree, never commit, writes/migrations go through approval. The page does double duty: human doc **and** session context the runner injects so it queries consistently every turn (house rule: code without a brain page is incomplete).

## Phase 4 — approval cards for any mutation/migration ✅
- ✅ The session **never executes a write directly.** If it concludes something needs an INSERT/UPDATE/DELETE/DDL or a migration, it stops and emits a **`pending_actions` approval card** describing the change (summary + the exact statement/script + preview), reusing the existing gated-action pattern from [[box-ticket-improve]] / [[migration-fix-agent]].
- ✅ Only Dylan's approval turns a card into a real change, and only **deterministic worker code** executes it — never the model freestyling SQL.
- ✅ Schema changes (new table / column / migration) are **not** this session running DDL — they ride the integrated spec→build handoff (Phase 5), since the message center must not write code or run migrations itself.

## Phase 5 — integrated spec handoff ✅
- ✅ When it spots a code/capability gap it can draft a spec (with **owner + parent** per the spec format) and surface a one-click action that drops it straight into the **spec-chat finalize → optional build** pipeline — no copy-paste. Reuse the `enqueueSpecChat(mode:'finalize')` + optional `kind='build'` path from [[box-spec-chat]].
- ✅ Planning use case: it reads `docs/brain/goals/` + the brain and proposes specs against big-picture goals — an ad-hoc, conversational cousin of [[../specs/goal-decomposition-engine]] / the `plan-goal` skill, but driven by a live founder conversation rather than a batch plan job.

## Phase 6 — UI: Developer > Message Center ✅
- ✅ New `dev_message_threads` table (dedicated, not riding `roadmap_chats` — different lifecycle: no `finalize`/`spec_slug` terminal state, but it does carry approval cards). Columns mirror the proven shape: `id`, `workspace_id`, `user_id`, `title`, `messages` (jsonb `[{role,content}]`), `box_session_id`, `turn_status` (`idle|thinking|error`), `last_error`, `pending_actions` (jsonb), `created_at`, `updated_at`. Brain page in [[../tables/README]].
- ✅ Sidebar item **"Message Center"** under the owner-only Developer section in `src/app/dashboard/sidebar.tsx`, route `/dashboard/developer/messages`.
- ✅ Chat page is a near-copy of `src/app/dashboard/roadmap/AuthoringChat.tsx`: optimistic user message → `POST /api/developer/messages` enqueues the `dev-ask` turn job → poll `GET /api/developer/messages?id=` every ~3s while `turn_status='thinking'` → render the reply when it returns to `idle`; "thinking on the box…" affordance for the minutes-long latency; resume list of recent threads.
- ✅ Approval cards render inline in the thread (summary + preview + Approve/Dismiss); Approve enqueues the `approve_action` job; spec-handoff renders as a one-click "Send to spec / Send & build" button.

## Safety / invariants
- **Report-back, never a builder.** No product/committed code is ever written by this session; the only artifacts it produces are scratch query scripts (uncommitted) and *proposals* (spec drafts, approval cards).
- **Reads free, writes gated — always.** SELECT/join/analysis runs silently; every INSERT/UPDATE/DELETE/DDL/migration stops at an approval card that only the owner's click executes, and only deterministic worker code runs the approved change. The model never executes a mutation itself.
- **The service key can write; the gate is the boundary.** "Read-only" is a policy enforced by the tool surface + approval gate, not by the DB key. This matches the existing full-cred box agents ([[box-ticket-improve]], [[migration-fix-agent]]).
- **Max only.** Launched `claude -p` with `env -u ANTHROPIC_API_KEY` — no per-token spend, never the Anthropic API, never a nested claude.
- **North star (supervisable autonomy).** The tool surfaces its reasoning, and the founder is the objective-owner who approves every state-changing action; hitting the write/migration rail = escalate (an approval card), not execute. See [[../operational-rules]].
- **Concurrency-1 lane** keeps interactive turns serialized and prevents the per-thread worktree's self-update (`git reset --hard`) from racing an in-flight read; must not starve the 5 build/plan lanes (its own pool).
- **Owner-only.** The page and API are gated to `workspace.role === 'owner'`, like the rest of the Developer section.

## Completion criteria
- A "Message Center" item appears under Developer (owner-only) at `/dashboard/developer/messages`; opening it starts/resumes a thread.
- A turn enqueues a `dev-ask` job, the box claims it on its own 1-lane, runs a Max `claude -p` session with brain + repo + read-only DB + WebSearch, and the reply lands back in the thread within the polling loop.
- Asking an analytics question ("how many storefront sessions had add-to-carts in the last 7 days?") returns a correct number, derived via a throwaway query script that is **not** committed.
- Asking "does {feature} work right now?" returns a grounded read-only investigation (code + brain + recent Inngest/error rows), no mutation.
- Proposing a mutation/migration produces an approval card; nothing changes in the DB until the owner approves, and the approved change is executed only by worker code.
- Finding a gap produces a one-click spec handoff that lands a `docs/brain/specs/{slug}.md` (with owner + parent) and optionally queues a build — same pipeline as spec-chat.
- A brain page documents the DB-query convention; `npx tsc --noEmit` is green.

## Verification

> **Pre-req (gated prod write):** apply the migration first — `npx tsx scripts/apply-dev-message-threads-migration.ts` (creates `public.dev_message_threads` + index + RLS). Idempotent.

- On the dashboard sidebar as the **owner**, expand **Developer** → expect a **"Message Center"** item linking to `/dashboard/developer/messages`; as a non-owner, expect the whole Developer section hidden, and visiting the route directly → expect the "available to the workspace owner only" notice (API returns 403).
- On `/dashboard/developer/messages`, type a question and Send → expect an optimistic user bubble, a "Thinking on the box…" line, and within the ~3 s poll loop an assistant reply; then probe `agent_jobs` → expect one `kind='dev-ask'` row `status='completed'` with `instructions` JSON `{thread_id, mode:'turn'}`, and the `dev_message_threads` row's `box_session_id` set + `turn_status='idle'`.
- On a fresh box, confirm `claim_agent_job(p_kinds => '{dev-ask}')` returns the queued row and the worker log prints `claimed dev-ask … → 1/1 dev-ask lane` (concurrency-1; the build/plan lanes still fill independently).
- Ask a countable analytics question (e.g. "how many storefront_sessions in the last 7 days?") → expect a number that matches a direct read-only `probe-db` count; inspect the thread worktree (`builds/dev-ask-<id>`) mid/post-turn → expect the query ran as an **uncommitted** `scripts/_*.ts` and `git status` shows **no** committed changes / no `docs/brain/` or `src/` edits.
- Ask "does {feature} work right now?" → expect a grounded read-only investigation (cites code + brain + read-only row probes) and **no** mutation / no approval card.
- Prompt it toward a data write ("set X on row Y") → expect the reply to STOP and render an inline **🗄️ Database write** card (summary + `cmd`/preview), the target table **unchanged** in the DB; click **Approve & apply** → expect a `dev-ask` `{mode:'approve_action'}` job, the card flips to `done`, a "Done: …" assistant note appears, and the row is now changed (executed by `runDeveloperMessageJob`, not mid-session). Click **Dismiss** instead → expect the card `declined` and the DB untouched.
- Steer it to a code/capability gap → expect a **📄 Spec handoff** card; click **Send to spec** (or **Send & build**) → expect `docs/brain/specs/{slug}.md` committed to `main` with a valid `**Owner:**`/`**Parent:**` line, and (Send & build) one `kind='build'` `agent_jobs` row `status='queued'`.
- In the worker logs/heartbeat, confirm the `dev-ask` session launched with `ANTHROPIC_API_KEY` unset (Max billing, $0 marginal); confirm `docs/brain/recipes/dev-message-center-db.md` exists; `npx tsc --noEmit` is clean.
