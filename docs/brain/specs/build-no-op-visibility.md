# Build Console: No Silent No-Op Builds + Report-Issue Enqueue Confirmation ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — Roadmap build-console reliability (hardens [[../lifecycles/roadmap-build-console]] · [[../specs/build-approval-gates]])

A build only opens a PR when it produces a git commit. Today, when a build makes **no committed changes**, the worker still marks it `status=completed` with **no PR, no error, and no reason** — it reads as success on the board but nothing shipped. For a **Report Issue**, that's a phantom 'done.' Separately, the Report-Issue submit path doesn't confirm a job was actually enqueued, so a dropped submission also looks fine.

## Evidence (dev-ask investigation, 2026-06-21)
- Build-job status: 77 merged (all w/ PR), 7 completed w/ PR, **3 completed with NO PR — all `log_tail = 'no file changes; nothing to commit'`** (two storefront-iteration-engine phases + the worker smoke test).
- A founder Report Issue ('make the dev-message-center typing window bigger') has **no agent_jobs row and no chat record anywhere** — it never enqueued a build, yet was perceived as 'the system did it.'
- The one genuine Report-Issue build (iteration-engine meta_400) committed + opened PR #152 → the path works **when a job runs and produces a diff**.

## Phase 1 — No-op builds surface as needs_attention (not silent completed) ✅
- In `scripts/builder-worker.ts` build outcome handling: when a build returns `completed` but the branch has **no commit / empty diff** ('nothing to commit'), set `status='needs_attention'` with `error`/reason = the agent's stated **no-change reason** (lifted from the final-status JSON `summary` / `log_tail`), instead of `completed`.
- Require the build's final JSON to carry a `no_changes_reason` when it makes no edits (update the `build-spec` skill contract). The card then shows **'Build made no changes — <reason>'** with a Retry, never a bare 'completed' with no PR.
- Brain: [[../lifecycles/roadmap-build-console]] § Outcomes, [[../tables/agent_jobs]] (status semantics), `.claude/skills/build-spec`.

## Phase 2 — Report-Issue enqueue confirmation ✅
- `POST /api/roadmap/build` (report-issue path) returns the created job id; the dashboard (`BuildButton.tsx`) and Slack `/bug` ([[../libraries/roadmap-actions]]) confirm **'Issue queued as build <id>'** and link the card. On enqueue failure, surface an error — a dropped submit must never look successful.
- Brain: [[../dashboard/roadmap]], [[../integrations/slack-roadmap-console]].

## Phase 3 — Scope guard for vague issues (optional) ✅
- When a Report Issue can't be tied to a confident file/component, the build should pause on `needs_input` ('which screen/component?') rather than no-op to `completed`. Reuses the existing `needs_input` round-trip.
- Implemented at the **build-spec skill contract** level (no separate code path needed): the worker build prompt and `.claude/skills/build-spec/SKILL.md` now instruct the agent that an issue too vague to tie to a confident file/component must return `needs_input` asking which screen/component, never a no-op `completed`. The existing `needs_input` round-trip ([[../tables/agent_jobs]] → answer form / Slack modal) carries it. Phase 1's no-op guard is the safety net if the agent ignores this and produces zero edits anyway.

## Verification
- [ ] On `/dashboard/roadmap`, Report Issue on an already-satisfied spec with an instruction the build can't act on (e.g. "make sure X is true" where X already holds) → when the build finishes, the card chip shows **Needs attention** (rose), the `error` reads **"Build made no changes — <reason>"**, and there is **no PR link** — never a green "Built" with no PR.
- [ ] In `scripts/builder-worker.ts`, the build-outcome path computes `git rev-list --count origin/main..HEAD` on a clean tree: `0` → `update(job, { status: "needs_attention", error: "Build made no changes — …" })`; a build that committed during a pause (commits ahead > 0) still un-drafts its existing PR → `completed`.
- [ ] On `/dashboard/roadmap`, open Report issue, type a description, Queue fix → a green **"✓ Issue queued as build `<id>`"** banner appears and the card shows an active chip. The build id is the first 8 chars of the `agent_jobs.id`.
- [ ] Simulate enqueue failure (e.g. DevTools offline, or the API returns non-2xx) on the Report-Issue submit → a red **"⚠ Couldn't queue… nothing was submitted"** banner appears, the form stays open, and no active card is created — no false confirmation.
- [ ] In Slack `#roadmap`, `/bug <slug> <desc>` → the ephemeral reads **"🐛 Issue queued as build `<id>` for `<slug>`"**; a `queueRoadmapBuild` failure (e.g. bad slug) → "Couldn't queue …" ephemeral, never a false success. The App-Home Build button echoes the id too.
- [ ] Positive control: run a real fix-build that makes an actual edit end-to-end → produces a commit + `claude/*` PR and the card shows **Built** with a PR link (the path still ships real diffs).
- [ ] `npx tsc --noEmit` passes; brain pages ([[../lifecycles/roadmap-build-console]], [[../tables/agent_jobs]], [[../dashboard/roadmap]], [[../integrations/slack-roadmap-console]]) + `.claude/skills/build-spec/SKILL.md` updated in the same PR.
