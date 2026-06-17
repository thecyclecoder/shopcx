---
name: build-spec
description: Use to implement a ShopCX brain spec end-to-end — read docs/brain/specs/{slug}.md, build every phase, gate on tsc, and open a claude/* PR. Triggered by "build the {slug} spec", a spec_build todo, or a /goal-style "do everything in docs/brain/specs/{slug}.md". Designed to run inside a Claude Code Routine OR a local/box session.
---

# build-spec

Execute a brain spec to a reviewable PR. This is the procedure a routine runs for the [[roadmap-build-console]] vision and that a `/goal` session runs locally.

## 🔒 Core invariant — never shell out to `claude`

Do the build with **your own native tools** (`Read`/`Edit`/`Bash`/`Grep`). **Never** spawn a nested `claude` CLI (`claude -p …`) or use the Agent SDK to do the build — inside a routine you are already in a `claude` session (`CLAUDECODE=1`) and a nested CLI exits 1. You *are* the builder.

## Procedure

1. **Read the spec.** `docs/brain/specs/{slug}.md`. Note every `## Phase` and its emoji (`⏳ planned · 🚧 in progress · ✅ shipped`), the `## Safety / invariants`, and `## Completion criteria`.
2. **Probe before assuming.** Use the `probe-db` skill for any table/enum/column the spec touches — the database is the spec. Don't trust column shapes from prose.
3. **Implement phase by phase.** Match surrounding code style. For schema changes use the `write-migration` skill. Every new table/inngest fn/library/integration also needs a brain page (CLAUDE.md hard rule) — use `write-brain-page`/`fold-to-brain`.
4. **Update the spec emojis as you go** — `⏳`→`🚧`→`✅` on each phase, in the same change.
5. **Gate on types.** Run `npx tsc --noEmit`. If it fails, fix it; **never open a PR on a failing build.**
6. **Stop-and-surface, never guess.** If you hit a product decision the spec doesn't cover, do NOT guess — record it under an "Open questions" section in the PR body and stop *that* work item. Finish everything else.
7. **Open a `claude/*` PR.** Branch `claude/{slug}-{short}`. Use the **GitHub REST API** (the routine sandbox has no `gh` CLI). PR body = what landed + open questions + which completion criteria are met. Code **never** auto-merges — the owner squash-merges from `/dashboard/branches`.

## Guardrails

- Branch from the default branch; never commit to `main` directly.
- Internal joins use UUIDs, never `shopify_*_id`. DB writes go through `createAdminClient()`.
- Don't push during active Inngest syncs (Vercel deploy kills running functions).
- A build always **terminates** — "done" or "done what I could + open questions." It never blocks waiting for input.

## Related
`docs/brain/specs/{slug}.md` · skills: `probe-db`, `write-migration`, `write-brain-page`, `fold-to-brain` · `docs/brain/lifecycles/agent-todo-system.md` (PR plumbing) · `src/lib/agent-todos/system-execute.ts`
