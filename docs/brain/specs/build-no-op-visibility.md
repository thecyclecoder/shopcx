# Build Console: No Silent No-Op Builds + Report-Issue Enqueue Confirmation ⏳

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — Roadmap build-console reliability (hardens [[../lifecycles/roadmap-build-console]] · [[../specs/build-approval-gates]])

A build only opens a PR when it produces a git commit. Today, when a build makes **no committed changes**, the worker still marks it `status=completed` with **no PR, no error, and no reason** — it reads as success on the board but nothing shipped. For a **Report Issue**, that's a phantom 'done.' Separately, the Report-Issue submit path doesn't confirm a job was actually enqueued, so a dropped submission also looks fine.

## Evidence (dev-ask investigation, 2026-06-21)
- Build-job status: 77 merged (all w/ PR), 7 completed w/ PR, **3 completed with NO PR — all `log_tail = 'no file changes; nothing to commit'`** (two storefront-iteration-engine phases + the worker smoke test).
- A founder Report Issue ('make the dev-message-center typing window bigger') has **no agent_jobs row and no chat record anywhere** — it never enqueued a build, yet was perceived as 'the system did it.'
- The one genuine Report-Issue build (iteration-engine meta_400) committed + opened PR #152 → the path works **when a job runs and produces a diff**.

## Phase 1 — No-op builds surface as needs_attention (not silent completed) ⏳
- In `scripts/builder-worker.ts` build outcome handling: when a build returns `completed` but the branch has **no commit / empty diff** ('nothing to commit'), set `status='needs_attention'` with `error`/reason = the agent's stated **no-change reason** (lifted from the final-status JSON `summary` / `log_tail`), instead of `completed`.
- Require the build's final JSON to carry a `no_changes_reason` when it makes no edits (update the `build-spec` skill contract). The card then shows **'Build made no changes — <reason>'** with a Retry, never a bare 'completed' with no PR.
- Brain: [[../lifecycles/roadmap-build-console]] § Outcomes, [[../tables/agent_jobs]] (status semantics), `.claude/skills/build-spec`.

## Phase 2 — Report-Issue enqueue confirmation ⏳
- `POST /api/roadmap/build` (report-issue path) returns the created job id; the dashboard (`BuildButton.tsx`) and Slack `/bug` ([[../libraries/roadmap-actions]]) confirm **'Issue queued as build <id>'** and link the card. On enqueue failure, surface an error — a dropped submit must never look successful.
- Brain: [[../dashboard/roadmap]], [[../integrations/slack-roadmap-console]].

## Phase 3 — Scope guard for vague issues (optional) ⏳
- When a Report Issue can't be tied to a confident file/component, the build should pause on `needs_input` ('which screen/component?') rather than no-op to `completed`. Reuses the existing `needs_input` round-trip.

## Verification
- [ ] Force a no-change build (e.g. an already-satisfied issue) → card shows `needs_attention` + the no-change reason, not `completed`; no phantom PR-less success.
- [ ] Submit a Report Issue → UI shows 'queued as build <id>' and the card appears; kill the API mid-submit → an error is shown, no false confirmation.
- [ ] Re-run the real fix (MessageCenterChat.tsx textarea rows={2}→taller) end-to-end → produces a commit + `claude/*` PR (positive control that the path still ships real diffs).
- [ ] Brain pages updated in the same PR.
