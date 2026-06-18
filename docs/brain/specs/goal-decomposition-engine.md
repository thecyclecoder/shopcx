# Goal Decomposition Engine ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

A layer **above** specs: write a huge company goal (a BHAG), and a planner agent does gap-analysis against the brain, proposes a milestone → spec tree, and — once you approve the branches — auto-authors the leaf specs and queues their builds. Same substrate as the Roadmap Build Console ([[roadmap-build-console]]), one altitude up: where `build-spec` turns a spec into a PR, the **planner** turns a goal into specs. The first goal it runs on is [[../goals/ceo-mode|CEO mode]] — and its first act is to surface the integrations/data we still need (Amazon, COGS/supplier, a metrics spine) as specs. Decomposition is **human-gated**: the planner proposes, you approve which branches to pursue before any spec is written or built.

**No orphan specs.** Every spec belongs to something bigger, and the parent chain terminates at the org chart — the **functions** (Growth, CMO, Retention, CFO, Logistics, CS — the CEO-mode directors — plus Platform/Eng, the build org) from [[../goals/ceo-mode]]. A spec's parent is one of two kinds:
- a function **mandate** — a *perpetual* charter a function owns forever (e.g. Growth's "static-ad optimization"), measured by a metric trend, never "done"; or
- a goal **milestone** — part of a *finite* initiative (e.g. CEO mode) that closes at 100%.

Either way a spec declares an **owner** (exactly one function — the DRI) and a **parent** (a mandate or a milestone). Functions are the permanent skeleton; goals and mandates are how work attaches to it. A `functions/{slug}.md` doc does double duty: the director-agent's CEO-mode charter **and** the home that owns its mandates + specs. See [[../functions/growth]] for the worked example ([[winning-static-creative-finder]] under the static-ad mandate).

## Background — what already exists (don't rebuild)

- **Execution** is done: [[../tables/agent_jobs]] queue + `claim_agent_job` RPC + the box worker ([[../recipes/build-box-setup]], `scripts/builder-worker.ts`) + the `build-spec` skill + `claude/*` PR flow + the phone-first answer/approve loop ([[../dashboard/roadmap]], `/api/roadmap/{build,answer,approve}`).
- **Spec authoring** is done: the Opus `chat/finalize` flow (`/api/roadmap/chat`) already writes `docs/brain/specs/{slug}.md` and can queue a build.
- **Status model** is done: phase emojis (⏳🚧✅) parsed by `src/lib/brain-roadmap.ts` (`getRoadmap`/`getSpec`), spec status derived in `deriveStatus()`.
- **Missing:** any layer ABOVE a spec. Today `specs/README.md` "Active project" tracks are read-only groupings with no rollup and no planner. This spec adds the **functions + goals + mandates** layers + the planner + the no-orphan rule.

## Phase 1 — Functions + Goals + Mandates data layer + parser
- ✅ shipped
- **Functions** — `docs/brain/functions/{slug}.md`, one per director (growth, cfo, cmo, logistics, cs). The permanent skeleton. Sections: scope + owned metrics; `## Mandates` (each a perpetual charter with a tracked metric + `[[spec-slug]]` wikilinks); `## Owned goals` (finite initiatives this function leads or contributes to). Doubles as the CEO-mode director charter ([[../goals/ceo-mode]]). See [[../functions/growth]].
- **Goals** — `docs/brain/goals/{slug}.md` (seed: [[../goals/ceo-mode]]). Frontmatter-free, markdown-first. Sections: outcome + **success metric** + target date; `## Current state`; `## Decomposition` (milestones, each with its own metric + `[[spec-slug]]` wikilinks); `## Status` (rolled up).
- **Specs gain owner + parent.** A metadata line near the H1: `**Owner:** [[../functions/{slug}]] · **Parent:** {goal-milestone or function-mandate}`. Exactly one owner-function (DRI); shared work gets one owner + "contributes-to" links.
- Extend `src/lib/brain-roadmap.ts`: `getFunctions()`/`getFunction()`, `getGoals()`/`getGoal()`, `GoalCard`/`FunctionCard` types, `parseGoal()`/`parseFunction()` (extract mandates + milestones + linked spec slugs + spec owner/parent). **Rollup:** goal % = weighted avg of linked specs' phase completion; a **mandate has no %** (perpetual) — it surfaces its metric trend + active spec count instead.
- `listGoalSlugs()`/`listFunctionSlugs()` for wikilink resolution; `[[goal-slug]]`→`/dashboard/roadmap/goals/{slug}`, `[[function-slug]]`→`/dashboard/roadmap/functions/{slug}`.

## Phase 2 — Functions + Goals board + detail UI
- ✅ shipped
- The roadmap board can now **group by Function → (Mandate | Goal) → Spec** instead of the flat Planned/In-progress/Shipped list (keep the flat view as a toggle).
- `/dashboard/roadmap/functions/[slug]` — the director's home: charter + mandates (each with its metric + owned specs) + owned/contributed goals.
- `/dashboard/roadmap/goals` + `/dashboard/roadmap/goals/[slug]` — goal board cards (success metric, rollup % bar, milestone count) + detail (rendered markdown + milestone tree with each leaf spec's live status). Owner-only "Plan"/"Re-plan" per goal (Phase 3 wires it).
- Each spec card/detail shows its **owner + parent** breadcrumb (Function › Mandate/Goal › Spec).
- `next.config.ts` `outputFileTracingIncludes` must include `docs/brain/goals/**` and `docs/brain/functions/**` (Vercel prunes `docs/brain` otherwise; see [[../dashboard/roadmap]]).

## Phase 3 — Planner job kind + skill
- ✅ shipped
- Add `kind text not null default 'build'` to [[../tables/agent_jobs]] (`'build' | 'plan'`); migration + apply-script ([[write-migration]]). `claim_agent_job` is kind-agnostic (worker branches on `kind`).
- New `.claude/skills/plan-goal/` skill. Procedure: read `goals/{slug}.md` (or a `functions/{slug}.md` mandate) + the **brain** (the current-state model) → for the success metric, identify what capabilities/data/integrations exist (cite brain pages) vs. are missing → produce a **proposed milestone tree** where each leaf is either an existing `[[spec]]` or a NEW spec to author (title + one-paragraph intent + which brain gap it closes + **owner function + parent**). Every proposed spec MUST name an owner + parent — the planner rejects its own orphans. The planner does NOT write specs or build in this pass — it emits the tree for approval.
- Box worker (`scripts/builder-worker.ts`): when it claims a `kind='plan'` job, run the plan-goal skill instead of build-spec. The proposed tree comes back as the job's `pending_actions` (one action per proposed branch: `{id, type:'spec', summary, preview: intent, status:'pending'}`) → job goes `needs_approval`. Reuse the existing draft-PR + pause mechanics.

## Phase 4 — Approve tree → auto-author specs → queue builds
- ✅ shipped
- Reuse `/api/roadmap/approve` for plan jobs: approving a branch marks that action approved. When all branches have a decision, job → `queued_resume`.
- Worker resumes the plan job: for each **approved** branch, author `docs/brain/specs/{slug}.md` (reuse the `chat/finalize` authoring path / the same Opus prompt), commit it, insert a `kind='build'` `agent_jobs` row (so the existing build pipeline takes over), and update `goals/{slug}.md` `## Decomposition` to wikilink the new spec under its milestone. Declined branches are recorded (❌) so re-plan doesn't re-propose them.
- One PR for the planning output (new spec files + goal-doc update); builds then open their own `claude/*` PRs as usual.

## Phase 5 — Rollup + re-plan loop
- ✅ shipped
- Goal page shows live rollup; as leaf specs ship (✅) the goal % advances with no extra action.
- "Re-plan" re-runs the planner with current state (specs that shipped, data that changed) → proposes only the **newly-revealed** gaps (e.g. once the metrics spine ships, CEO-mode's analyst-loop spec becomes proposable). Re-plan never touches already-approved/in-flight branches.

## Safety / invariants
- **Planner proposes, human disposes.** No spec is authored and no build is queued until the owner approves that branch. (Owner's call, 2026-06-18.) Mirrors the existing PR-merge gate — now there's also a gate on *direction*.
- **The planner never builds directly.** It only authors specs + queues `build` jobs, which still produce `claude/*` PRs the owner merges. Two gates total: approve-tree, then merge-PR.
- **Grounded in the brain.** Every "we already have X" / "X is a gap" claim in a proposed tree must cite the brain page that proves it. No hallucinated current-state.
- **No orphan specs.** Every spec declares an `owner` (exactly one function — the DRI) and a `parent` (a function mandate or a goal milestone). The planner rejects proposals without both; a board lint flags any existing spec not referenced by exactly one function/goal.
- **Mandate vs goal.** A goal is finite and rolls up to 100% then closes; a mandate is perpetual (no %, metric-tracked) and keeps emitting specs. Don't model a perpetual charter as a goal.
- **Markdown-first.** Functions, goals, and mandates all live in git (`docs/brain/functions/`, `docs/brain/goals/`), not new tables. The only schema change is `agent_jobs.kind`.
- **One active plan per goal** (same guard as one active build per spec).
- **Token/scope discipline.** A plan pass is one bounded agent run; it does not recurse autonomously — a milestone that's still too big is proposed as a **sub-goal** (its own `goals/` doc) for a future, separately-approved plan pass.

## Completion criteria
- I can commit a `goals/{slug}.md`, open it on `/dashboard/roadmap/goals/{slug}`, tap **Plan**, and get back a proposed milestone → spec tree with brain-cited gap analysis — every proposed spec carrying an owner + parent.
- Approving a subset of branches auto-authors exactly those specs (with owner/parent set), wikilinks them into the goal/function doc, and queues their builds — declined branches are not re-proposed.
- The board groups by Function → (Mandate | Goal) → Spec; the goal card shows a rollup % that advances as leaf specs ship; a mandate shows its metric + active spec count.
- No orphan specs: the lint passes, and [[../functions/growth]] owns the [[winning-static-creative-finder]] spec under its static-ad mandate.
- `goals/ceo-mode.md` runs end-to-end and its first plan surfaces the Amazon / COGS-supplier / metrics-spine gaps as proposed specs, each owned by a function.
