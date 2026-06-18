# Goal Decomposition Engine ⏳

A layer **above** specs: write a huge company goal (a BHAG), and a planner agent does gap-analysis against the brain, proposes a milestone → spec tree, and — once you approve the branches — auto-authors the leaf specs and queues their builds. Same substrate as the Roadmap Build Console ([[roadmap-build-console]]), one altitude up: where `build-spec` turns a spec into a PR, the **planner** turns a goal into specs. The first goal it runs on is [[../goals/ceo-mode|CEO mode]] — and its first act is to surface the integrations/data we still need (Amazon, COGS/supplier, a metrics spine) as specs. Decomposition is **human-gated**: the planner proposes, you approve which branches to pursue before any spec is written or built.

## Background — what already exists (don't rebuild)

- **Execution** is done: [[../tables/agent_jobs]] queue + `claim_agent_job` RPC + the box worker ([[../recipes/build-box-setup]], `scripts/builder-worker.ts`) + the `build-spec` skill + `claude/*` PR flow + the phone-first answer/approve loop ([[../dashboard/roadmap]], `/api/roadmap/{build,answer,approve}`).
- **Spec authoring** is done: the Opus `chat/finalize` flow (`/api/roadmap/chat`) already writes `docs/brain/specs/{slug}.md` and can queue a build.
- **Status model** is done: phase emojis (⏳🚧✅) parsed by `src/lib/brain-roadmap.ts` (`getRoadmap`/`getSpec`), spec status derived in `deriveStatus()`.
- **Missing:** any layer ABOVE a spec. Today `specs/README.md` "Active project" tracks are read-only groupings with no rollup and no planner. This spec adds the goal layer + the planner.

## Phase 1 — Goals data layer + parser
- ⏳ planned
- Define `docs/brain/goals/{slug}.md` format (see [[../goals/ceo-mode]] for the seed). Frontmatter-free, markdown-first like the rest of the brain. Sections: outcome + **success metric** (measurable) + target date; `## Current state` (what the brain says we already have); `## Decomposition` (milestone list, each milestone a checkpoint with its own metric and `[[spec-slug]]` wikilinks to leaf specs); `## Status` (rolled up).
- Extend `src/lib/brain-roadmap.ts`: `getGoals()`, `getGoal(slug)`, a `GoalCard` type, and `parseGoal()` that extracts milestones + linked spec slugs. **Rollup:** goal % = weighted average of its linked specs' phase completion (reuse the existing phase-emoji parse). A goal's status = in_progress if any spec in_progress, planned if all planned, shipped if all shipped.
- `listGoalSlugs()` for wikilink resolution; make `[[goal-slug]]` resolve to `/dashboard/roadmap/goals/{slug}` in the spec/goal renderers.

## Phase 2 — Goals board + detail UI
- ⏳ planned
- `/dashboard/roadmap/goals` — a board of goal cards (title, success metric, rollup % bar, milestone count, status dot). Owner-only "Plan" / "Re-plan" button per goal (Phase 3 wires it).
- `/dashboard/roadmap/goals/[slug]` — detail page: rendered goal markdown + the milestone tree with each leaf spec's live status (link into the existing spec detail page) + the rollup.
- Add a "Goals" entry point from the existing roadmap board. `next.config.ts` `outputFileTracingIncludes` must include `docs/brain/goals/**` (same fix as specs — Vercel prunes `docs/brain` otherwise; see [[../dashboard/roadmap]]).

## Phase 3 — Planner job kind + skill
- ⏳ planned
- Add `kind text not null default 'build'` to [[../tables/agent_jobs]] (`'build' | 'plan'`); migration + apply-script ([[write-migration]]). `claim_agent_job` is kind-agnostic (worker branches on `kind`).
- New `.claude/skills/plan-goal/` skill. Procedure: read `goals/{slug}.md` + the **brain** (the current-state model) → for the goal's success metric, identify what capabilities/data/integrations exist (cite brain pages) vs. are missing → produce a **proposed milestone tree** where each leaf is either an existing `[[spec]]` or a NEW spec to author (title + one-paragraph intent + which brain gap it closes). The planner does NOT write specs or build in this pass — it emits the tree for approval.
- Box worker (`scripts/builder-worker.ts`): when it claims a `kind='plan'` job, run the plan-goal skill instead of build-spec. The proposed tree comes back as the job's `pending_actions` (one action per proposed branch: `{id, type:'spec', summary, preview: intent, status:'pending'}`) → job goes `needs_approval`. Reuse the existing draft-PR + pause mechanics.

## Phase 4 — Approve tree → auto-author specs → queue builds
- ⏳ planned
- Reuse `/api/roadmap/approve` for plan jobs: approving a branch marks that action approved. When all branches have a decision, job → `queued_resume`.
- Worker resumes the plan job: for each **approved** branch, author `docs/brain/specs/{slug}.md` (reuse the `chat/finalize` authoring path / the same Opus prompt), commit it, insert a `kind='build'` `agent_jobs` row (so the existing build pipeline takes over), and update `goals/{slug}.md` `## Decomposition` to wikilink the new spec under its milestone. Declined branches are recorded (❌) so re-plan doesn't re-propose them.
- One PR for the planning output (new spec files + goal-doc update); builds then open their own `claude/*` PRs as usual.

## Phase 5 — Rollup + re-plan loop
- ⏳ planned
- Goal page shows live rollup; as leaf specs ship (✅) the goal % advances with no extra action.
- "Re-plan" re-runs the planner with current state (specs that shipped, data that changed) → proposes only the **newly-revealed** gaps (e.g. once the metrics spine ships, CEO-mode's analyst-loop spec becomes proposable). Re-plan never touches already-approved/in-flight branches.

## Safety / invariants
- **Planner proposes, human disposes.** No spec is authored and no build is queued until the owner approves that branch. (Owner's call, 2026-06-18.) Mirrors the existing PR-merge gate — now there's also a gate on *direction*.
- **The planner never builds directly.** It only authors specs + queues `build` jobs, which still produce `claude/*` PRs the owner merges. Two gates total: approve-tree, then merge-PR.
- **Grounded in the brain.** Every "we already have X" / "X is a gap" claim in a proposed tree must cite the brain page that proves it. No hallucinated current-state.
- **Markdown-first.** Goals live in git (`docs/brain/goals/`), not a new table. The only schema change is `agent_jobs.kind`.
- **One active plan per goal** (same guard as one active build per spec).
- **Token/scope discipline.** A plan pass is one bounded agent run; it does not recurse autonomously — a milestone that's still too big is proposed as a **sub-goal** (its own `goals/` doc) for a future, separately-approved plan pass.

## Completion criteria
- I can commit a `goals/{slug}.md`, open it on `/dashboard/roadmap/goals/{slug}`, tap **Plan**, and get back a proposed milestone → spec tree with brain-cited gap analysis.
- Approving a subset of branches auto-authors exactly those specs, wikilinks them into the goal doc, and queues their builds — declined branches are not re-proposed.
- The goal card shows a rollup % that advances as leaf specs ship.
- `goals/ceo-mode.md` runs end-to-end and its first plan surfaces the Amazon / COGS-supplier / metrics-spine gaps as proposed specs.
