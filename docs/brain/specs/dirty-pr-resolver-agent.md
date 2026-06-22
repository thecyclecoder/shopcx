# Dirty-PR Resolver Agent (auto-clean conflicting build PRs) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[roadmap-build-console]] + [[build-approval-gates]]. Box-agent family. Complements [[spec-blockers]] (which *prevents* collisions) — this *cleans up* the ones that still happen.

Parallel builds + failed-then-rebuilt builds keep producing **dirty (`CONFLICTING`) `claude/*` PRs** — I've hand-resolved a dozen this week (merge `origin/main`, resolve additively, `tsc`, push) and occasionally had to rebuild-on-main when two builds diverged. Automate it: when a PR goes dirty, a box agent resolves it (or escalates if it can't), so the owner never hand-merges a conflict again.

## Trigger — event-driven (on dirty), NOT a cron
- A **GitHub webhook** (`push` to `main` — the event that *makes* other PRs conflict — and `pull_request` opened/synchronize) hits `/api/webhooks/github`. On it, list **open `claude/*` PRs**, check each `mergeable` (GitHub recomputes async after a push), and for any that just became **`CONFLICTING`**, enqueue **one `pr-resolve` `agent_jobs`** for that PR (deduped: skip a PR already being resolved). No cron — it fires the moment a merge dirties something.

## The agent (`pr-resolve` box kind)
A `claude -p` on Max (keeps git/gh; KEEPS no prod creds) that, for one dirty `claude/*` PR:
1. Worktree the PR branch, **`git merge origin/main`**, resolve the conflicts. Most are **additive** (both sides add a registry entry / enum case / list item / doc section → keep both) or **doc add/add** (keep the shipped version) — the LLM resolves with that judgment.
2. **`npx tsc --noEmit` gate** — a resolved merge must compile. If it doesn't, the agent does NOT push a broken merge.
3. Push the resolved merge to the PR branch → the PR goes green.
- **Decision: resolve vs rebuild vs human.** If the conflict is **simple/additive** → resolve + push. If the two sides **diverged heavily** on the same files (parallel rewrites — not a clean union, like the control-tower P2 × agent-coverage collision) **or tsc can't pass after a reasonable attempt** → do NOT force a semantically-wrong merge: for a **spec build**, **rebuild on main** (close the PR + re-queue the build, which branches off current `main` — a clean base); otherwise **surface to the owner** (a Control Tower / Slack note: "PR #N needs a human merge: {why}"). Cap attempts (≤1–2) so it never loops.

## Guardrails (supervisable autonomy)
- **`claude/*` build branches only** — never touches a human PR or `main` directly.
- **tsc-gated** — never pushes a merge that doesn't compile; never resolves by deleting code to "win" a conflict.
- **Escalate, don't guess** — a genuine semantic conflict (two real logic changes to the same path) is surfaced for a human / rebuilt, not force-merged. Logs its resolution per the North Star.
- Idempotent + de-duped (one resolve per PR at a time); a PR it can't fix is flagged, not retried forever.

## Verification
- Merge a PR to `main` that dirties an open `claude/*` PR → the webhook fires, a `pr-resolve` job is enqueued for the dirty PR; the agent merges `origin/main`, resolves the (additive) conflict, tsc passes, pushes → the PR flips `CONFLICTING → MERGEABLE`, no human touch.
- A heavily-diverged conflict (parallel rewrites of one file) → the agent does **not** force-merge; it rebuilds the spec on main (closes + re-queues) or surfaces "needs a human merge: {why}".
- A resolution that fails tsc → the agent never pushes it; it escalates instead.
- Negative: a non-`claude/*` PR or a clean PR triggers nothing.

## Phase 1 — webhook trigger + pr-resolve agent + escalation ⏳
The GitHub webhook → dirty-`claude/*` detection → `pr-resolve` `agent_jobs` enqueue; the `pr-resolve` box kind + lane + `runPrResolveJob` (merge → resolve → tsc → push, or rebuild/surface); the resolve-vs-rebuild-vs-human decision. Brain: [[../tables/agent_jobs]] (new kind) · [[../recipes/build-box-setup]] (lane) · new webhook page · [[control-tower]] (register the `pr-resolve` lane + surface "needs human merge").
