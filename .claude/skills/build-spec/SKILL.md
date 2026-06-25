---
name: build-spec
description: Use to implement a ShopCX brain spec end-to-end — read docs/brain/specs/{slug}.md, build every phase, gate on tsc, and open a claude/* PR. Triggered by "build the {slug} spec", a spec_build todo, or a /goal-style "do everything in docs/brain/specs/{slug}.md". Designed to run as the box worker's headless claude -p build OR a local/interactive session.
---

# build-spec

Execute a brain spec to a reviewable PR. This is the procedure the box worker's `claude -p` build follows for [[roadmap-build-console]], and that an interactive session runs locally.

## 🔒 Core invariant — native tools; never spawn a *nested* `claude`

Do the build with **your own native tools** (`Read`/`Edit`/`Bash`/`Grep`). The build already runs as a **top-level `claude -p` on the build box** (the worker spawns it, Max-billed) — or your interactive session. You *are* the builder. **Never** spawn another `claude` CLI (`claude -p …`) or use the Agent SDK inside it: that recursion hits the nested-session guard (`CLAUDECODE=1`) and exits 1. (Builds run on the box, not a Claude Code Routine — a routine couldn't run `claude -p` at all.)

## Procedure

1. **Read the spec.** `docs/brain/specs/{slug}.md`. Note every `## Phase` and its emoji (`⏳ planned · 🚧 in progress · ✅ shipped`), the `## Safety / invariants`, and `## Completion criteria`. **An empty (0-byte) or phaseless spec is a build failure, not a build target** — if the file is blank or has no `## Phase` section, do NOT invent a spec or merge an empty PR: stop and surface it (`needs_input`, "spec body is empty/phaseless — re-author it before building"). A real spec to build always has at least one `## Phase`. (db-health-spec-body-robust.)
2. **Probe before assuming.** Use the `probe-db` skill for any table/enum/column the spec touches — the database is the spec. Don't trust column shapes from prose.
3. **Implement phase by phase.** Match surrounding code style. For schema changes use the `write-migration` skill. Every new table/inngest fn/library/integration also needs a brain page (CLAUDE.md hard rule) — use `write-brain-page`/`fold-to-brain`.

   **One PR ships ONE phase ([[../../docs/brain/specs/spec-status-phase-pr-provenance]]).** Status is DB-driven now: a phase is `shipped` iff a build PR merged it (the merge hook stamps `spec_card_state.phase_states[i].{pr,merge_sha}` with this PR # + merge SHA — provable, not inferred). So a phase is "already done" iff its DB `phase_state` carries a `pr` — judge the unbuilt delta by **code-on-main AND a PR tag**, not by markdown emojis or by counting merged builds. The pre-flight check below already reads code-on-main; combine with the DB phase tags so the next un-shipped phase is what you build. A **one-shot spec** (no `## Phase` sections) is the whole spec in one PR; a **single-phase spec** is the whole spec in one PR tagged at P0. Don't bundle phases into one PR unless the spec is one-shot — each phase wants its own PR so the audit trail (PR # ↔ phase) stays clean.
4. **Update the spec emojis as you go** — `⏳`→`🚧`→`✅` on each phase, in the same change. **On completion, flip the H1 title emoji to match the phase consensus** — set the `# Title …` emoji to `✅` once every phase has shipped (none `⏳`/`🚧`), so the markdown is self-consistent and a forgotten title doesn't read as "Doing." (The board's parser already treats an all-`✅` phase set as shipped regardless of the title — this is belt-and-suspenders so the raw markdown agrees. Leave an explicit `❌` cut title alone.)
5. **Write the `## Verification` section.** On completion, add (or refresh) a `## Verification` section to `specs/{slug}.md` — a concrete, prod-facing test checklist built from what you *actually* touched (the real routes / Slack actions / CLI / tables). Each bullet: the exact place, the input, and the **observable expected result** — shape `- On {where}, {do what} → expect {observable result}.` Never vague ("test it works"). This is what the owner follows to verify the feature before archiving ([[verification-guides]]); a shipped spec must arrive test-ready.
6. **Gate on types.** Run `npx tsc --noEmit`. If it fails, fix it; **never open a PR on a failing build.**
7. **Stop-and-surface, never guess.** If you hit a product decision the spec doesn't cover, do NOT guess — record it under an "Open questions" section in the PR body and stop *that* work item. Finish everything else.
8. **Open a `claude/*` PR.** Branch `claude/{slug}-{short}`, via the **GitHub REST API** (no `gh` CLI on the box). PR body = what landed + open questions + which completion criteria are met. Code **never** auto-merges — the owner squash-merges from `/dashboard/branches`. *(When the box worker is driving the build, the worker owns branch/commit/PR — you just make the edits and emit your final status JSON; it handles git.)*

## Guardrails

- Branch from the default branch; never commit to `main` directly.
- Internal joins use UUIDs, never `shopify_*_id`. DB writes go through `createAdminClient()`.
- Don't push during active Inngest syncs (Vercel deploy kills running functions).
- **Gated prod actions:** under the box worker you have **no prod credentials**. To apply a migration or run a prod-mutating script, author it as code first (write-migration skill), then emit `{"status":"needs_approval","actions":[{"type":"apply_migration","summary":"…","cmd":"npx tsx scripts/apply-X-migration.ts"}]}` and stop — the worker runs it on the owner's one-tap approval and resumes you. (Locally/interactively you may apply directly.)
- **Don't re-request a settled action.** On a **resume**, the prompt reports what already ran — `Gated actions executed: …` and/or `Already-applied gated actions — treat as SETTLED, do NOT re-request them: …`. Treat anything listed there as **done**: do NOT re-emit it in a new `needs_approval`. Re-requesting an already-applied migration is what caused the approval **loop** this guardrail exists to stop. (The worker also auto-settles an exact-`cmd` re-request as a backstop, but rely on this, not the backstop.)
- **Probe before requesting a migration.** Before emitting an `apply_migration` approval, use `probe-db` to check whether the change already exists (table/column/index/enum present). If it's already there, **skip the request** and continue — apply-scripts are idempotent, so the goal is to stop the needless pause, not the apply.
- A build always **terminates** with one status — `completed`, `needs_input` (product questions), or `needs_approval` (gated prod actions). It never blocks waiting for input.
- **Emit `no_changes_reason` when you make no edits.** If the build makes zero file edits (already implemented / nothing to do), still return `{"status":"completed","summary":"…","no_changes_reason":"why nothing changed"}`. The worker turns a no-edit build with no PR into `needs_attention` carrying this reason — never a bare `completed` with no PR that masquerades as done. (See `docs/brain/specs/fix-report-issue-dropped.md` Phase 3.)

## Related
`docs/brain/specs/{slug}.md` · skills: `probe-db`, `write-migration`, `write-brain-page`, `fold-to-brain` · `docs/brain/lifecycles/agent-todo-system.md` (PR plumbing) · `src/lib/agent-todos/system-execute.ts`
