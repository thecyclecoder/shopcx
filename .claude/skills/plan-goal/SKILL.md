---
name: plan-goal
description: Use to run ONE human-gated planning pass on a ShopCX goal (or a function mandate) — gap-analyze the goal against the brain and propose a milestone → spec tree where each leaf is an existing spec or a NEW spec to author (with owner + parent). Triggered by a kind='plan' agent_jobs row on the box worker. The planner PROPOSES; it never writes specs or builds.
---

# plan-goal

Turn a goal into a proposed milestone → spec tree. This is the layer ABOVE `build-spec`: where build-spec turns a spec into a PR, the planner turns a goal into specs. **It proposes; the owner disposes.** No spec is authored and no build is queued in this pass — you emit the tree, the owner approves branches, then the worker authors the approved leaves straight to `public.specs` (DB-driven; you never write files).

The goal lives in `public.goals` + `public.goal_milestones` — there is NO `docs/brain/goals/{slug}.md` (the per-goal markdown was retired). The worker materializes the goal ROW for you to a gitignored scratch file (`.box/goal-{slug}.md`) and points you at it. Read THAT file for the goal's outcome, success metric, body, and its `## Decomposition` (each milestone rendered as `### M{n} — {title}` with a `_milestone_id: {uuid}_` line). Do NOT look for `docs/brain/goals/{slug}.md` — it does not exist.

## 🔒 Core invariants

- **Planner proposes, human disposes.** Output a tree for approval. Do **not** write any file (no `docs/brain/specs/*.md`, no goal doc), do **not** queue builds, do **not** run git. After the owner approves, the worker resumes you for ONE structured-JSON authoring pass — you return the spec bodies as JSON and the worker writes the DB rows. You never touch disk.
- **Grounded in the brain — no hallucinated current-state.** Every "we already have X" / "X is a gap" claim must cite the brain page that proves it (`docs/brain/<folder>/<slug>.md`). Read the brain before asserting. If you can't cite it, don't claim it.
- **No orphan specs.** Every proposed spec MUST declare an **owner** (exactly one `functions/{slug}` — the DRI) and a **parent** (a goal milestone or a function mandate). Reject your own orphans — a proposal without both is invalid; drop it or fix it.
- **Bounded — one pass, no autonomous recursion.** Propose the tree at ONE level. If a milestone is still too big to be a single spec, propose it as a **sub-goal** (note it in the intent) for a separate, later plan pass — do not recurse now.

## Procedure

1. **Read the materialized goal.** The scratch render at `.box/goal-{slug}.md` (path given in the prompt) — its outcome, **success metric**, body, and `## Decomposition` (each milestone is `### M{n} — {title}` with a `_milestone_id: {uuid}_` line — these are the real `goal_milestones` rows). (Or a `docs/brain/functions/{slug}.md` mandate, if planning a mandate.)
2. **Read the brain to ground current state.** For the success metric, walk the relevant `tables/`, `inngest/`, `integrations/`, `lifecycles/`, `libraries/` pages. Start at `docs/brain/README.md`. Build a two-column model: **what exists** (cite the page) vs **what's missing** (the gap, and which page would prove it exists once built).
3. **Map specs already on the board.** The materialized goal lists each milestone's already-attached child specs (`- [[../specs/{slug}]] — {title} _(status)_`). A milestone leaf may be an EXISTING spec (reference it by slug, don't re-propose) or a NEW spec to author. Do NOT glob `docs/brain/specs/` — the specs live in `public.specs`; the materialized goal is your source for what already exists under this goal.
4. **Propose the tree.** For each milestone in the goal's decomposition, list its leaf specs. Each NEW leaf is a proposal carrying:
   - `slug` — kebab-case, unique (not an existing spec or a declined one).
   - `title` — the spec's H1.
   - `owner` — exactly one function slug (growth | cmo | retention | cfo | logistics | cs | platform).
   - `parent` — the goal milestone (e.g. `M1 — Metrics spine + COGS`) or a function mandate.
   - `milestone` — the milestone HANDLE this attaches under: the `M{n}` handle from the materialized goal (e.g. `M1`). The worker resolves it to the real `goal_milestones.id` and binds `specs.milestone_id`.
   - `intent` — one paragraph: what to build + which capability/data gap it closes.
   - `gap` — the brain page(s) that prove the gap (the grounding citation).
   - `blocked_by` — the (possibly empty) list of prerequisite slugs (sibling proposals or existing specs) this branch depends on. Acyclic. Empty `[]` for a foundation spec.
5. **Respect already-decided branches.** If the goal records declined or already-attached branches, do NOT re-propose them (re-plan only surfaces newly-revealed gaps).
6. **Emit the tree as your final JSON** (below) and STOP. The worker turns each proposal into a `pending_actions` entry and pauses the job at `needs_approval`.

## Final output (the ONLY thing in your last message)

One JSON object. Each proposed branch is one action; `type` is always `"spec"`:

```json
{"status":"needs_approval","actions":[
  {"type":"spec","summary":"<title>","preview":"<intent — one paragraph>\n\nGap: <brain citation>","spec":{
    "slug":"metrics-spine","title":"Metrics spine + COGS store","owner":"platform","parent":"M1 — Metrics spine + COGS","milestone":"M1","intent":"<one paragraph>","gap":"no unifying spine — goals/ceo-mode Current state; tables/orders covers revenue only","blocked_by":[]}}
]}
```

If the goal is fully decomposed (every milestone already has its specs) and there are no new gaps, return `{"status":"completed","summary":"No new gaps — tree already covers the goal."}`.

If you hit a genuine product decision the goal doesn't cover (and can't ground in the brain), return `{"status":"needs_input","questions":[{"id":"q1","q":"…"}]}` instead of guessing.

## Related
`docs/brain/project-management.md` (the work hierarchy) · `docs/brain/functions/` · skills: `build-spec` (the layer below), `probe-db`
