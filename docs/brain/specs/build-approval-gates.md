# Build Approval Gates + Execution Hardening ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

Harden the [[roadmap-build-console]] executor so autonomous builds run with **minimal back-and-forth** (bypass mode — no per-tool prompts) while staying **safe**: the few irreversible / prod-mutating actions (apply a migration, run a prod-mutating script, merge to `main`) come back as **one-tap approvals on the spec/phase card**, executed by the *trusted worker*, not the sandboxed build. This extends [[../tables/agent_jobs]] — the live DB companion to the static brain — with an approval/action layer.

**Business outcome:** Dylan fires a build from anywhere and it completes autonomously, pausing only for a genuine product question or a handful of consequential approvals (surfaced async on his phone). No terminal, no per-tool prompts, no unsafe prod access.

**Status (2026-06-18):** all phases implemented + deployed. **Phase 1 proven end-to-end** — a build ran under bypass as the non-root `builder` user, sandboxed env, on Max, and opened a PR. The approval round-trip (Phases 3–4) is fully wired + deployed; it gets its first real exercise the next time a build needs a migration. Box details folded into [[../recipes/build-box-setup]].

## The model (why this shape)

- **Brain markdown (`main`)** = canonical, *static* spec definitions. Changes only when a PR merges.
- **`agent_jobs` (DB companion)** = *live, actionable* state: build status, `needs_input` questions, and now **`needs_approval` pending actions**. The worker polls it; the dashboard renders it as buttons. Pending actions MUST live here, not on the unmerged `claude/*` branch — that's why a DB companion is required (the card can't read an unmerged branch).
- **Safety is credential-enforced, not prompt-enforced.** The build (`claude -p`) has **no prod-write credentials** and produces a branch → PR (code gated by your review). The **worker holds prod creds** and executes *only* approved actions. So bypass is safe: a runaway command literally cannot reach prod.

## Phase 1 — Bypass + powerless build env ✅
- ⏳ Worker spawns the build with **bypassPermissions** (`--dangerously-skip-permissions`) so it runs edits / `tsc` / tests / local scripts with zero prompts.
- ⏳ Run builds as a **non-root `builder` user** (the dangerous flag is refused as root; non-root also limits OS blast radius). One-time Claude `/login` as `builder` so it bills to **Max** (or share a `CLAUDE_CODE_OAUTH_TOKEN`).
- ⏳ **Strip prod-write creds from the build env** + trim the repo `.env.local` the build reads, by moving the worker's prod secrets into a `systemd` `EnvironmentFile` (`/root/shopcx-worker.env`, root-only). The build inherits none of: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, Braintree, etc.

## Phase 2 — Approval-gate state on agent_jobs ✅
- ⏳ Migration: add `needs_approval` to the status enum + `pending_actions` jsonb (`[{id, type, summary, preview, status}]`) + `approvals` jsonb. Gated `type`s: `apply_migration`, `run_prod_script`, `merge_pr`.
- ⏳ Worker: when the build requests a gated action, the worker records a `pending_action`, sets `needs_approval`, and pauses — reusing the existing `needs_input` pause/resume plumbing (Phase 5 of [[roadmap-build-console]]).

## Phase 3 — Approval API + card buttons ✅
- ⏳ `POST /api/roadmap/approve` — owner-gated `{ jobId, actionId, decision }` → marks the action approved/declined; on approve, flip the job to `queued_resume`.
- ⏳ `BuildButton` renders `pending_actions` as buttons with a **preview** of what's being approved: "Approve & apply migration" (show the SQL), "Approve: run `<script>`".
- ⏳ "**Squash & merge**" button on the card once the PR is ready (reuse `POST /api/branches/[number]/merge`), so merge is a card action too.

## Phase 4 — Worker = trusted executor ✅
- ⏳ On `queued_resume` with an approved action, the **worker** (the only component with prod creds) executes it — apply the migration via its apply-script, run the prod script, or merge the PR — records the result on the job, then `claude --resume`s the build to verify/continue.
- ⏳ The build process itself never executes prod actions (it has no creds to).

## Phase 5 — DRY: worker invokes the build-spec skill ✅
- 🚧 Worker prompt references the **`build-spec` skill** instead of an inline copy (single source of truth) — staged in `scripts/builder-worker.ts`.
- ⏳ Align the `build-spec` skill: author migrations (don't apply), the worker owns git/PR + approvals.

## Safety / invariants
- **Bypass is safe ONLY because of all four:** (1) build output is a `claude/*` PR — code never hits prod until *you* merge; (2) the build env has **no prod-write creds** (credential-enforced, not instruction-enforced); (3) prod-mutating actions require an explicit owner tap; (4) builds run **non-root**.
- **Gated (require a tap):** `apply_migration`, `run_prod_script`, `merge_pr`. Everything else runs autonomously under bypass.
- **The worker is the only component with prod creds**, and the only thing that executes an approved action.
- **Max billing preserved:** the build runs `claude` with `ANTHROPIC_API_KEY` stripped (`env -u`).
- **Approvals live in `agent_jobs` (live), not the brain (static)** — the card reads them regardless of merge state.

## Completion criteria
- A build that needs a migration **pauses**; the card shows "Approve & apply" with the SQL preview; tapping it applies (via the worker) and the build resumes and finishes.
- A ready PR shows "**Squash & merge**" on the card; tapping merges.
- Builds run bypass under a non-root `builder` user with **no prod-write creds**; confirmed a build cannot reach prod without an approval.
- The worker drives builds via the `build-spec` skill (no duplicated inline prompt).

## Open questions
- **`builder` user auth:** one-time Max `/login` as `builder` vs. a shared long-lived `CLAUDE_CODE_OAUTH_TOKEN` from the root login.
- **Shadow DB** for in-build migration *testing* (deferred) vs. author-only + post-approval apply (current plan).
- **Preview generation** for `pending_actions` — how much to surface (full SQL, a diff, script path + args).
- **Approval grouping** — per-action vs. "approve all pending for this build" once trust builds.

## Related
[[roadmap-build-console]] · [[repo-skills-catalog]] · [[../recipes/build-box-setup]] · [[../tables/agent_jobs]] · [[../dashboard/branches]] · [[../dashboard/roadmap]]
