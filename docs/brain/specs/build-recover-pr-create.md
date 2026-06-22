# Build Done but PR-Create Failed → "Create PR" (recover, don't discard) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[roadmap-build-console]] + [[build-approval-gates]].

When a build **succeeds and pushes its branch** but the final `gh pr create` step fails (transient GitHub error / rate-limit), the worker flags the job **`needs_attention`** with `error="branch pushed but PR creation failed"`. The card then only offers **Rebuild** — which **throws away a completed build** (observed: `control-tower-complete-coverage` P1 — a clean 19-min, ~$15 Opus build whose PR just failed to open; I had to open #185 by hand). Rebuilding a successful build is pure waste. The card should offer **Create PR** to recover it.

## Model
- **Detect the recoverable sub-case.** A `needs_attention` job whose `error` is the PR-create-failed class **and whose branch exists on origin** = recoverable (the work is done + pushed). Distinguish it from genuinely-stuck `needs_attention` (e.g. dirty-PR resolver "needs a human merge", a crash-loop) which still wants human eyes.
- **"Create PR" action on the card.** For the recoverable case, the card's primary button is **Create PR** (not Rebuild): `POST /api/roadmap/build` with an action that runs `gh pr create` (or the GitHub API) for the pushed branch against `main`, then flips the job → `completed` with the new `pr_url`/`pr_number`. Rebuild stays available as a secondary (in case the branch is bad), clearly labeled as discard-and-redo.
- **Worker retries first.** Before flagging `needs_attention`, the worker retries `gh pr create` a couple times with backoff (most failures are transient) — so the manual recover is the rare fallback, not the norm.
- **Idempotent:** if a PR already exists for the branch, Create PR adopts it (attaches its url/number) rather than erroring.

## Guardrails
- Create PR only opens a PR for an **already-pushed `claude/*` build branch** — never pushes code, never touches `main`.
- The recoverable detection is evidence-gated (branch must exist on origin); a `needs_attention` with no pushed branch keeps the human-attention treatment.

## Verification
- On a `needs_attention` build card whose `error` is `"branch pushed but PR creation failed"` and whose `spec_branch` is set (e.g. the `control-tower-complete-coverage`/#185 case), the [[../dashboard/roadmap|BuildButton]] shows a **Create PR** primary button + a demoted **"Rebuild (discard)"** secondary, with a note naming the pushed branch → expect Create PR present, Rebuild labeled discard-and-redo.
- Click **Create PR** (`POST /api/roadmap/build { jobId, recoverPr:true }`) for a branch that exists on origin with no PR → expect a new PR opened against `main` for that branch, the job flips to `completed` with `pr_url`/`pr_number` set + `error` cleared, and the card re-buckets to **Built** with **Squash & merge**.
- Click **Create PR** when an **open PR already exists** for the branch → expect it is **adopted** (response `adopted:true`, no duplicate PR), job → `completed` with that PR attached.
- Trigger `createPrForJob` for a `needs_attention` job whose `spec_branch` does **not** exist on origin (deleted/never pushed) → expect `409 "Branch … not found on origin"`, job stays `needs_attention` (no false success).
- On a genuinely-stuck `needs_attention` (no `spec_branch`, or a different `error` like the dirty-resolver `"needs a human merge"`) → expect the card shows the plain treatment, **not** a Create PR button (`recoverable` is false).
- In `scripts/builder-worker.ts`, force a transient first `gh pr create` failure that succeeds on a later attempt → expect `ensurePr` retries with backoff and returns the PR, so the job reaches `completed` and **never** hits `needs_attention`.

## Phase 1 — Create-PR recovery action + worker retry ✅
The `gh pr create` retry-with-backoff in the worker before flagging; the recoverable-`needs_attention` detection (PR-create-failed + branch-exists); the **Create PR** card action (`POST /api/roadmap/build` → open-PR-for-branch → job `completed`); idempotent adopt-existing-PR. Brain: [[../libraries/agent-jobs]] · [[roadmap-build-console]] · [[../dashboard/roadmap]] (BuildButton) · [[../recipes/build-box-setup]].
