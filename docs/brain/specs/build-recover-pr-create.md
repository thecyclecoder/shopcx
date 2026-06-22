# Build Done but PR-Create Failed → "Create PR" (recover, don't discard) ⏳

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
- Force a build whose `gh pr create` fails (branch pushed, no PR) → job `needs_attention`, error "branch pushed but PR creation failed" → the card shows **Create PR** (primary) + Rebuild (secondary). Click Create PR → a PR opens for the pushed branch, job → `completed` with the PR attached, card shows Built + merge. (Re-validates the #185 case.)
- Create PR when a PR already exists for the branch → adopts it (no duplicate), job → `completed`.
- A genuinely-stuck `needs_attention` (no pushed branch / dirty-resolver human-merge) → still shows the human-attention treatment, not a misleading Create PR.
- The worker's pre-flag retry: a transient first `gh pr create` failure that succeeds on retry → never reaches `needs_attention` at all.

## Phase 1 — Create-PR recovery action + worker retry ⏳
The `gh pr create` retry-with-backoff in the worker before flagging; the recoverable-`needs_attention` detection (PR-create-failed + branch-exists); the **Create PR** card action (`POST /api/roadmap/build` → open-PR-for-branch → job `completed`); idempotent adopt-existing-PR. Brain: [[../libraries/agent-jobs]] · [[roadmap-build-console]] · [[../dashboard/roadmap]] (BuildButton) · [[../recipes/build-box-setup]].
