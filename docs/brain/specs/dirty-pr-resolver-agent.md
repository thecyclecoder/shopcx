# Dirty-PR Resolver Agent (auto-clean conflicting build PRs) ✅

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
- Configure the repo webhook (`https://shopcx.ai/api/webhooks/github`, secret = `GITHUB_WEBHOOK_SECRET`, events Pushes + Pull requests). On the GitHub **Recent Deliveries** tab, redeliver a `push` → expect a `200` with `{ok:true, checked, conflicting, enqueued}`; a delivery with a bad/absent signature → expect `401`.
- Merge a PR to `main` that dirties an open `claude/*` PR → expect the webhook to enqueue ONE `agent_jobs` row `kind='pr-resolve'`, `spec_slug='pr-{N}'`, `pr_number=N` (verify in the DB / on the build console). The box `pr-resolve` lane then merges `origin/main`, resolves the (additive) conflict, the **worker's** tsc gate passes, it pushes → on GitHub the PR flips `CONFLICTING → MERGEABLE` and the job lands `completed` with `log_tail` "resolved + pushed", no human touch.
- Fire the webhook twice in a row for the same dirty PR (push + synchronize) → expect only ONE active `pr-resolve` job (the second `enqueuePrResolveJob` no-ops on the `pr-{N}` dedupe).
- A heavily-diverged conflict (parallel rewrites of one file) OR a merge that can't compile after the resolve → expect the worker to NOT push; it closes the PR + re-queues a fresh `kind='build'` row for the originating spec off a clean `main` (job `error='rebuilt-on-main: …'`), or — if no originating `build` row is found — sets the job `needs_attention` and DMs owners/admins "Control Tower: PR #N needs a human merge: {why}" via Slack (`notifyOpsAlert`).
- Force a resolution that leaves a conflict marker / unmerged path / a tsc error → expect the worker gate (`merge-base --is-ancestor`, `git ls-files -u`, conflict-marker grep, `npx tsc --noEmit`) to reject it and escalate instead of pushing.
- On `/dashboard/developer/control-tower`, expect an **Agent — PR resolve** tile (`agent:pr-resolve`); idle = green, a `pr-resolve` job stuck > 45 min flips it red + pages owners.
- Negative: a `push` to a non-`main` ref, a non-`claude/*` PR, or a clean (`mergeable===true`) PR → expect `{ok, skipped}` or `enqueued:0`, nothing enqueued.

## Phase 1 — webhook trigger + pr-resolve agent + escalation ✅
Shipped. The [[../integrations/github-webhook|GitHub webhook]] (`src/app/api/webhooks/github/route.ts`) → dirty-`claude/*` detection + enqueue ([[../libraries/github-pr-resolve]] `verifyGithubWebhook` / `detectAndEnqueueDirtyPrs` / `enqueuePrResolveJob`) → `pr-resolve` `agent_jobs` row; the `pr-resolve` box kind + concurrency-1 lane (`MAX_PR_RESOLVE`) + `runPrResolveJob` in `scripts/builder-worker.ts` (worktree → `claude -p` merges `origin/main` + resolves additively → the **worker** runs the tsc gate + merge-correctness checks + pushes, or rebuilds-on-main / surfaces to the owner); the resolve-vs-rebuild-vs-human decision, capped + deduped. Brain: [[../tables/agent_jobs]] (new `pr-resolve` kind) · [[../recipes/build-box-setup]] (lane) · [[../integrations/github-webhook]] (new webhook page) · [[../libraries/github-pr-resolve]] (new library) · [[control-tower]] (registered the `agent:pr-resolve` lane; "needs human merge" surfaces via [[../libraries/notify-ops-alert]]).
