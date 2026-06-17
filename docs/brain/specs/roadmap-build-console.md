# Roadmap Build Console — describe → spec → autonomous build → merge, all from the web app ⏳

> **🔒 CORE INVARIANT — the routine builds it itself; it never shells out to `claude`.** Inside a Claude Code Routine you are *already* in a `claude` session (`CLAUDECODE=1`), so spawning a new `claude` CLI — directly (`claude -p "/goal …"`) or via the Agent SDK — hits the nested-session guard and exits 1. The build MUST be done by the routine's **own native agent** (`Read`/`Edit`/`Bash`/`Grep` + GitHub REST API for the PR), never a subprocess. (A spawned `claude -p "/goal …"` is only valid on a *self-hosted worker box*, where `claude` is the top-level process — the Phase-4 "Open questions" executor fork.)

A phone-first console on the dashboard that closes the loop from *idea* to *merged PR* without a laptop or a terminal. Three surfaces over infrastructure we already have ([[../lifecycles/agent-todo-system]]): a **roadmap board** that reads the brain and shows what's planned / in progress / shipped; a **spec-authoring chat** where you talk a feature through with Opus until you love it, and it writes the `docs/brain/specs/{slug}.md` + creates a build todo; and a **build dispatcher** that runs the spec autonomously on your **Max subscription** (via the existing Claude Code Routine) and opens a `claude/*` PR you squash-merge from `/dashboard/branches`.

**Business outcome:** Dylan can stand up new work from anywhere ("on the pickleball court") — describe a feature on his phone, refine the spec in chat, tap *build*, and merge the resulting PR — with Dylan-level judgment preserved at the spec-approval and PR-merge gates.

## Billing model (the whole point — see invariants)

Two deliberate cost models:
- **Spec-authoring chat → Anthropic API (Opus).** Interactive in-app chat; the app backend calls Opus (direct or via Vercel AI Gateway). Cheap conversation tokens. A routine *cannot* do this (routines aren't conversational).
- **Spec execution / build → Max subscription.** The Claude Code Routine's **own native agent** does the coding with its native tools. **Max-billed only if** the build routine's env has **no `ANTHROPIC_API_KEY`** and it does NOT shell to a Messages-API script. (Verified: today's `agent-todo-routine` is API-billed because `reasoning.ts:368-402` calls the Messages API with `x-api-key` and `ANTHROPIC_API_KEY` is in its env per `scripts/print-routine-env.ts:35`. The build path must avoid both.)

## What already exists (reuse, don't rebuild)

- **`agent_todos`** approval queue ([[../tables/agent_todos]]) — has `source='manual'`, `payload` jsonb, `code_change` PR action, owner-only approval, drift, group_id. Migration `supabase/migrations/20260604190000_agent_todos.sql`.
- **Claude Code Routine** ([[../inngest/agent-todo-routine]]) — created at `claude.ai/code/routines`, **schedule + on-demand API trigger**, network policy allowlisting Supabase/OpenAI/GitHub, opens `claude/*` PRs via the GitHub REST API (not `gh` CLI), `git apply --recount`, CI gate `npx tsc --noEmit`.
- **`/dashboard/branches`** ([[../dashboard/branches]]) — every open `claude/*` PR with CI status + mergeability + **owner squash-merge from the dashboard** (phone-friendly). `POST /api/branches/[number]/merge`.
- **`/dashboard/tickets/todos`** approval UI + `/api/todos/[id]/approve` (which already wakes the routine on-demand for system todos).
- **The brain spec convention** ([[../project-management]]) — `docs/brain/specs/{slug}.md` with `⏳ 🚧 ✅` phase emojis; `specs/README.md` index.

---

## Phase 1 — Roadmap board (read-only) ⏳

A phone-friendly dashboard page that parses the brain and renders the status board the user originally asked for.

- ⏳ Route `src/app/dashboard/roadmap/page.tsx` (+ sidebar link). Server component.
- ⏳ Parser: read `docs/brain/specs/*.md` + `specs/README.md`; extract `⏳ / 🚧 / ✅` against `## Phase`/heading/bullet lines; also read the `## Status / open work` block from `lifecycles/*.md` for shipped features. (Markdown is the source of truth — no DB, never drifts.)
- ⏳ Render three columns — **Planned / In progress / Shipped** — grouped by project track (the `## Active project — …` headings in `specs/README.md`). Each card = a spec; expand to its phases.
- ⏳ Runtime file access on Vercel: ensure `docs/brain/**` is traced into the function bundle (or parse at build time). Decide + document.

## Phase 2 — Spec-authoring chat (Opus via API) ⏳

A chat window where Dylan describes a feature, iterates with Opus, and on "I love it" the assistant emits the spec file + a build todo.

- ⏳ Chat UI on `/dashboard/roadmap` (e.g. "New feature" → conversational panel). Phone-first.
- ⏳ Backend: `POST /api/roadmap/chat` streams Opus (Anthropic API or Vercel AI Gateway). System prompt loads the brain spec template ([[../project-management]] § Writing a spec) + relevant brain context so the spec is grounded in real tables/libs.
- ⏳ "Finalize" action: the model produces the full `docs/brain/specs/{slug}.md` content. The app:
  1. Creates the spec file on a `claude/*` branch via the GitHub REST API (consistent with `brain_doc_edit`), **and**
  2. Inserts an `agent_todos` row, `action_type='spec_build'`, `source='manual'`, `payload={ spec_slug, spec_branch, instructions }`, `status='pending'`.
- ⏳ The new spec shows on the board as ⏳ planned immediately.

## Phase 3 — `spec_build` todo type + dispatch trigger ⏳

- ⏳ Add `spec_build` to the `action_type` taxonomy (`src/lib/agent-todos/constants.ts`) — family **system**, approver **owner only**, executor **Routine (PR)**, **never auto-merges** (same class as `code_change`).
- ⏳ Board "Build" button = approve the `spec_build` todo → `POST /api/todos/[id]/approve` (existing path) → **wakes the routine on-demand** (existing capability). No new trigger plumbing.
- ⏳ Surface build status on the board card (pending → building → PR open → merged) by reading the todo's `status` + `execution_result.pr_url`.

## Phase 4 — Max-billed build executor (routine) ⏳

- ⏳ A **dedicated build routine** (separate from `agent-todo-routine`, or a clearly-gated branch of it) whose prompt: "Find approved `spec_build` todos. For each, read `docs/brain/specs/{slug}.md`, implement it with your **own native tools** (Read/Edit/Bash/Grep), run `npx tsc --noEmit`, open a `claude/*` PR via the GitHub REST API, update the todo (`status`, `execution_result.pr_url`)."
- ⏳ **Env: NO `ANTHROPIC_API_KEY`** (so the routine's native agent bills to Max). Do **not** call the Messages-API reasoning script in this path.
- ⏳ Per-spec PR; phase emojis in the spec flip ⏳→🚧→✅ as work lands (same as a `/goal` session would do locally).
- ⏳ **Stop-and-surface rule:** if the build hits a product decision the spec doesn't cover, it does NOT guess — it records the question under "Open questions" in the PR body and stops that item. Dylan answers in chat/PR; a follow-up build continues.

## Phase 5 — Review + merge from phone ⏳

- ✅ (exists) `/dashboard/branches` lists the `claude/*` PR with CI status + mergeability; owner **Squash & merge** works from the phone. Reuse as-is; just confirm `spec_build` PRs surface here (they will — head ref is `claude/*`).
- ⏳ Cross-link the board card → its PR on `/dashboard/branches`.

## Safety / invariants

- **Max-billing invariant:** the build routine's env must never contain `ANTHROPIC_API_KEY`, and the build path must never shell to a Messages-API script or spawn a nested `claude` CLI. Verify via [claude.ai/settings/usage] (should move) vs the API console (should stay flat). The authoring chat is the *only* sanctioned API spend.
- **Human gates preserved:** `spec_build` is owner-only to approve; PRs **never auto-merge** (mirrors `code_change`); merge to main is an owner click on `/dashboard/branches` with server-side re-validation.
- **CI gate:** `npx tsc --noEmit` before any PR opens (existing routine behavior). No broken PR reaches the branches surface.
- **Stop-and-surface, never block:** a build always terminates — "done" or "done what I could + open questions in the PR." It never hangs waiting for input (headless has no interactive channel).
- **Brain discipline:** the spec file IS the contract; the build folds new concepts into brain pages in the same PR (per [[../project-management]]).
- **One active build per spec** (mirror the `agent_todos` one-active-group-per-source guard).

## Completion criteria

- From a phone: open `/dashboard/roadmap`, see Planned/In-progress/Shipped from the brain.
- Describe a feature in chat, refine with Opus, finalize → a real `docs/brain/specs/{slug}.md` appears on a `claude/*` branch + a `spec_build` todo is created.
- Approve/tap Build → the routine implements it on **Max** (confirmed: API console flat, Max usage moves) → a CI-passing `claude/*` PR appears on `/dashboard/branches`.
- Squash-merge from the phone. Spec phase emojis reflect reality throughout.

## Open questions

- **Spec file delivery:** write straight to a `claude/*` branch from the authoring chat, or stage it as a `brain_doc_edit` todo first? (Leaning: branch directly — it's just a doc, low risk, and the build PR can amend it.)
- **One routine or two:** extend `agent-todo-routine` with a `spec_build` branch (API key present → would need careful per-task auth handling) vs. a **separate build routine with no API key** (cleaner billing isolation). Leaning separate.
- **Concurrency vs the daily run cap:** routines have a per-account daily run start cap — fine for occasional builds; revisit if Dylan fires many/day (then graduate to a self-hosted worker box with `CLAUDE_CODE_OAUTH_TOKEN`, swapping only the executor — UI/queue/PR layers unchanged).
- **Build-progress streaming:** poll the todo row vs. a live stream. Poll is simplest for v1.

## Related

[[../lifecycles/agent-todo-system]] · [[../inngest/agent-todo-routine]] · [[../tables/agent_todos]] · [[../dashboard/branches]] · [[../dashboard/tickets__todos]] · [[../project-management]] · [[README]]
