# Lifecycle: Roadmap Build Console (self-driving roadmap)

Describe a feature → spec → autonomous build on the **Max subscription** → answer questions / approve prod actions → merge — all from the dashboard (phone-friendly), no laptop or terminal. This is the end-to-end home for the shipped [[../specs/roadmap-build-console]] + [[../specs/build-approval-gates]] specs.

## Two layers (don't conflate)

- **Brain markdown (`main`)** — canonical, *static* spec definitions + final status (the `⏳ planned · 🚧 in progress · ✅ shipped · ❌ cut` phase emojis). Changes only when a PR merges. The board parses it.
- **`agent_jobs` (DB companion)** — *live, actionable* state: build status, `needs_input` questions, `needs_approval` pending actions. The box worker polls it; the dashboard renders it as buttons. Pending actions live here (not on the unmerged branch) — that's why a DB companion is required.

## Two runtimes

- **Vercel app** — the dashboard surfaces + APIs. Never touches the box. A "Build" tap just **inserts an `agent_jobs` row** in Supabase.
- **The box** ([[../recipes/build-box-setup]]) — a Hetzner CCX33, **Tailscale-only inbound**, runs `systemd: shopcx-builder` as the **non-root `builder`** user. It **polls Supabase outbound** (no inbound; the firewall stays shut — the box dials out, the app never dials in), claims a job, and runs the build as a headless `claude -p` on **Max**.

## End-to-end trace

1. **Author.** `/dashboard/roadmap` → **✨ New feature** opens the Opus authoring chat (`POST /api/roadmap/chat`, Anthropic API — the only sanctioned API spend). Talk it through → **Save spec** (commits `docs/brain/specs/{slug}.md` to `main` via GitHub API) or **Save & build** (also queues a job). **Refine with Opus** on a spec's detail page does the same for an *existing* spec. (Hand-written specs work too.)
2. **Dispatch.** **Build** on a card → `POST /api/roadmap/build` → inserts `agent_jobs` (`queued`). One active build per spec. Variants: per-phase **build** ([[../dashboard/roadmap]] PhaseList) and **Report issue** both queue a build scoped via `instructions` (no spec edit, spec stays ✅).
3. **Claim.** The worker calls `claim_agent_job()` (atomic, `FOR UPDATE SKIP LOCKED`) → `building`. It runs `claude -p --dangerously-skip-permissions` (bypass, no prompts) via the **`build-spec` skill**, as `builder`, with prod-write secrets **stripped from the build env** and no `ANTHROPIC_API_KEY` (stays on Max).
4. **Outcomes** (the build emits one final-status JSON):
   - `completed` → worker runs `npx tsc --noEmit` gate, commits, opens a `claude/*` PR.
   - `needs_input` (product question) → worker records `questions`, draft PR, pauses; the card shows an **answer form** → `POST /api/roadmap/answer` → `queued_resume` → worker `claude --resume`s.
   - `needs_approval` (gated prod action: `apply_migration` / `run_prod_script` / `merge_pr`) → worker records `pending_actions` + pauses; the card shows **Approve & apply** with the command preview → `POST /api/roadmap/approve` → worker (which holds prod creds) **executes the approved action**, then `--resume`s. The build itself never touches prod (credential-enforced).
   - `failed` / `needs_attention` → surfaced with `error` + `log_tail`.
5. **Review + merge.** The card's **Squash & merge** (or [[../dashboard/branches]]) merges the `claude/*` PR — owner-only, server-revalidated.
6. **Status reflects reality.** Spec emojis drive the board columns; `agent_jobs` drives the live per-card build chip + buttons.

## Safety model

Bypass is safe because of four things, not prompts: (1) **PR-gate** — code never hits prod until you merge; (2) **powerless build env** — secrets stripped, so a runaway command can't reach prod (credential-enforced); (3) **gated prod actions need a tap** — `apply_migration`/`run_prod_script`/`merge_pr` only run after owner approval, executed by the worker; (4) **non-root** builder user. The worker is the *only* component with prod creds.

## Billing

- **Authoring chat** → Anthropic API (Opus `claude-opus-4-8`), cheap conversation tokens.
- **Builds** → **Max subscription** (box `claude -p`, no API key). Verified: a real build ran bypass-as-builder on Max and opened a PR (2026-06-18).

## Code map

- Board + detail: `src/app/dashboard/roadmap/{page,[slug]/page}.tsx`; parser `src/lib/brain-roadmap.ts`.
- Components: `BuildButton.tsx` (build · status · answer · approve · squash-merge · report-issue), `StatusControl.tsx`, `PhaseList.tsx` (per-phase status + cut + build), `AuthoringChat.tsx` (new + refine).
- APIs: `src/app/api/roadmap/{build,status,answer,approve,chat}/route.ts`; merge reuses `/api/branches/[number]/merge`.
- Queue: [[../tables/agent_jobs]] + `src/lib/agent-jobs.ts` + `claim_agent_job()`.
- Worker: `scripts/builder-worker.ts` (box). Box runbook: [[../recipes/build-box-setup]].
- Skill: `.claude/skills/build-spec/`.

## Status / open work

**Shipped (2026-06-18):** the full loop — authoring chat (new + refine), board with editable status + per-phase status/cut, build dispatch + per-phase build + report-issue fix-builds, the box worker (non-root, bypass, sandboxed, Max), `needs_input` answer loop, `needs_approval` approval gates, and phone-merge. Box hardening (Phase 1 of build-approval-gates) live-proven via a real bypass-as-builder build.

**Awaiting first real exercise:** the `needs_input` and `needs_approval` round-trips are fully wired + deployed but haven't been triggered by a real build yet (the smoke build completed without needing either). The next migration-requiring build (e.g., finishing a stalled spec) will exercise the approval gate live.

**Known gaps / future:** worker concurrency vs Max rate limits (start 1–2); "commit without deploy" for status-only edits (deferred); fold the two source specs into this lifecycle + delete them on a housekeeping pass.

## Related

[[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../specs/repo-skills-catalog]] · [[../dashboard/roadmap]] · [[../dashboard/branches]] · [[../tables/agent_jobs]] · [[../recipes/build-box-setup]] · [[agent-todo-system]]
