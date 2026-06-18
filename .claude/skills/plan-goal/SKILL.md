---
name: plan-goal
description: Use to decompose a ShopCX goal (a BHAG in docs/brain/goals/{slug}.md) into a proposed milestone → spec tree, grounded in the brain. One altitude above build-spec — the planner turns a goal into specs, where build-spec turns a spec into a PR. Triggered by a kind='plan' agent_jobs job, "plan the {slug} goal", or "do gap-analysis for docs/brain/goals/{slug}.md". Human-gated: it proposes, the owner disposes — it never authors specs or builds in the propose pass.
---

# plan-goal

Decompose a goal into specs. This is the procedure the box worker runs for a `kind='plan'` [[../tables/agent_jobs]] job (see [[../specs/goal-decomposition-engine]]). Two passes, gated by owner approval in between:

1. **Propose pass** (fresh job) — gap-analyze the goal against the brain → emit a proposed milestone → spec tree as the job's `pending_actions`. **No spec files. No builds.**
2. **Author pass** (resume, after the owner approves a subset of branches) — author exactly the approved specs (with owner + parent), wikilink them into the goal doc, record declined branches. The worker then queues the builds.

## 🔒 Core invariants

- **Planner proposes, human disposes.** The propose pass writes NOTHING — no `specs/*.md`, no DB rows, no builds. It emits a tree for approval. Direction is gated before any spec exists.
- **No orphan specs.** Every proposed spec MUST carry an **owner** (exactly one function slug — the DRI) and a **parent** (a function mandate or a goal milestone). Reject your own orphans — if you can't name both, it's not ready to propose; make it a sub-goal instead.
- **Grounded in the brain.** Every "we already have X" / "X is a gap" claim must cite the brain page that proves it. Read the page; never hallucinate current-state.
- **Bounded — one pass, no autonomous recursion.** A milestone that's still too big to be a single spec is proposed as a **sub-goal** (`goals/{slug}.md`) for a future, separately-approved plan pass — not silently expanded here.
- **Mandate vs goal.** A goal is finite (rolls up to 100% then closes); a mandate is perpetual (no %, metric-tracked). Don't model a perpetual charter as a goal.
- **Native tools only; never spawn a nested `claude`** (same as build-spec — the build box already runs you as a top-level `claude -p`).

## Propose pass

1. **Read the goal.** `docs/brain/goals/{slug}.md` — its outcome, **success metric**, target, `## Current state`, and `## Decomposition` (the target milestone shape, if seeded). Also read its owning/contributing **functions** (`docs/brain/functions/*.md`) for their mandates.
2. **Gap-analysis against the brain.** For the success metric, walk what the goal needs and split it: what capabilities/data/integrations **already exist** (cite the brain page — `tables/`, `inngest/`, `integrations/`, `libraries/`, `lifecycles/`) vs. what is **missing**. Use `docs/brain/README.md` + the folder indexes; read pages, don't grep src/ first.
3. **Build the milestone tree.** Group the work into milestones (reuse the goal's `## Decomposition` shape when seeded). Each **leaf** is either:
   - an **existing** `[[spec]]` already on the roadmap that advances this milestone, or
   - a **NEW spec to author** — give it a title, a one-paragraph intent, the brain gap it closes (with the citation), and its **owner function + parent**.
4. **Emit the tree for approval.** Final message = ONLY one JSON object:
   ```
   {"status":"needs_approval","actions":[
     {"type":"spec","slug":"kebab-slug","owner":"cfo",
      "parent":"CEO mode M1 — Metrics spine + COGS",
      "summary":"<spec title>",
      "preview":"<intent paragraph> · closes gap: <X> (per brain page <cite>) · owner: <fn> · parent: <…>"}
   ]}
   ```
   Use `{"status":"needs_input","questions":[…]}` only for a genuine product decision the goal doc doesn't cover (never guess), or `{"status":"completed","summary":"…"}` when there is nothing new to propose.

## Author pass (resume — owner has approved a subset)

The worker resumes you with the approved + declined branches.

1. For **each approved** branch, author a complete `docs/brain/specs/{slug}.md` exactly like the [[build-spec]] inputs expect: `# <Title> ⏳`, then directly under it `**Owner:** [[../functions/{owner}]] · **Parent:** {parent}`, a one-paragraph outcome, concrete `## Phase N — name` sections (file paths / schema / tasks, each ⏳), `## Safety / invariants`, `## Completion criteria`. Concrete and brain-grounded — this spec will be built autonomously.
2. Update `docs/brain/goals/{slug}.md`: in `## Decomposition`, wikilink each authored spec `[[../specs/{slug}]]` under its milestone; add/extend a `## Declined` note listing declined branches with ❌ so a re-plan skips them.
3. Do NOT insert DB rows or run builds — the worker queues a `kind='build'` job per authored spec after you finish.
4. `npx tsc --noEmit` (docs-only; should pass). Final JSON: `{"status":"completed","summary":"authored N specs","authored":["slug",…]}`.

## Re-plan

A re-plan is just another propose pass over the same goal with current state. It must propose only the **newly-revealed** gaps (e.g. once the metrics spine ships, a dependent analyst-loop spec becomes proposable) and must NOT re-propose declined branches (read the goal's `## Declined` note) or touch already-approved / in-flight branches.

## Related
`docs/brain/specs/goal-decomposition-engine.md` · `docs/brain/goals/` · `docs/brain/functions/` · skills: `build-spec`, `probe-db` · [[../tables/agent_jobs]] · [[../dashboard/roadmap]]
