---
name: plan-goal
description: Use to run ONE human-gated planning pass on a ShopCX goal (or a function mandate) — gap-analyze the goal against the brain and propose a milestone → spec tree where each leaf is an existing spec or a NEW spec to author (with owner + parent). Triggered by a kind='plan' agent_jobs row on the box worker, or "plan docs/brain/goals/{slug}.md". The planner PROPOSES; it never writes specs or builds.
---

# plan-goal

Turn a goal into a proposed milestone → spec tree. This is the layer ABOVE `build-spec`: where build-spec turns a spec into a PR, the planner turns a goal into specs. **It proposes; the owner disposes.** No spec is authored and no build is queued in this pass — you emit the tree, the owner approves branches, then the worker (Phase 4) authors the approved leaves.

## 🔒 Core invariants

- **Planner proposes, human disposes.** Output a tree for approval. Do **not** write `docs/brain/specs/*.md`, do **not** queue builds, do **not** run git. (The worker authors approved branches after the owner approves.)
- **Grounded in the brain — no hallucinated current-state.** Every "we already have X" / "X is a gap" claim must cite the brain page that proves it (`docs/brain/<folder>/<slug>.md`). Read the brain before asserting. If you can't cite it, don't claim it.
- **No orphan specs.** Every proposed spec MUST declare an **owner** (exactly one `functions/{slug}` — the DRI) and a **parent** (a goal milestone or a function mandate). Reject your own orphans — a proposal without both is invalid; drop it or fix it.
- **Bounded — one pass, no autonomous recursion.** Propose the tree at ONE level. If a milestone is still too big to be a single spec, propose it as a **sub-goal** (`type:'goal'` note in the intent → a future `docs/brain/goals/` doc) for a separate, later plan pass — do not recurse now.

## Procedure

1. **Read the goal.** `docs/brain/goals/{slug}.md` — its outcome, **success metric**, target, `## Current state`, and `## Decomposition` (the target milestone shape). (Or a `docs/brain/functions/{slug}.md` mandate, if planning a mandate.)
2. **Read the brain to ground current state.** For the success metric, walk the relevant `tables/`, `inngest/`, `integrations/`, `lifecycles/`, `libraries/` pages. Start at `docs/brain/README.md`. Build a two-column model: **what exists** (cite the page) vs **what's missing** (the gap, and which page would prove it exists once built).
3. **Map specs already on the board.** Read `docs/brain/specs/` (+ each spec's `**Owner:** / **Parent:**`). A milestone leaf may be an EXISTING spec (reference it by slug, don't re-propose) or a NEW spec to author.
4. **Propose the tree.** For each milestone in the goal's decomposition, list its leaf specs. Each NEW leaf is a proposal carrying:
   - `slug` — kebab-case, unique (not an existing spec or a declined one).
   - `title` — the spec's H1.
   - `owner` — exactly one function slug (growth | cmo | retention | cfo | logistics | cs | platform).
   - `parent` — the goal milestone (e.g. `M1 — Metrics spine + COGS`) or a function mandate.
   - `milestone` — the milestone id (e.g. `M1`) this attaches under, for the goal-doc wikilink.
   - `intent` — one paragraph: what to build + which capability/data gap it closes.
   - `gap` — the brain page(s) that prove the gap (the grounding citation).
5. **Respect already-decided branches.** If the goal doc records declined (❌) or already-approved/in-flight branches, do NOT re-propose them (re-plan only surfaces newly-revealed gaps).
6. **Emit the tree as your final JSON** (below) and STOP. The worker turns each proposal into a `pending_actions` entry and pauses the job at `needs_approval`.

## Final output (the ONLY thing in your last message)

One JSON object. Each proposed branch is one action; `type` is always `"spec"`:

```json
{"status":"needs_approval","actions":[
  {"type":"spec","summary":"<title>","preview":"<intent — one paragraph>\n\nGap: <brain citation>","spec":{
    "slug":"metrics-spine","title":"Metrics spine + COGS store","owner":"platform","parent":"M1 — Metrics spine + COGS","milestone":"M1","intent":"<one paragraph>","gap":"no unifying spine — goals/ceo-mode Current state; tables/orders covers revenue only"}}
]}
```

If the goal is fully decomposed (every milestone already has its specs) and there are no new gaps, return `{"status":"completed","summary":"No new gaps — tree already covers the goal."}`.

If you hit a genuine product decision the goal doesn't cover (and can't ground in the brain), return `{"status":"needs_input","questions":[{"id":"q1","q":"…"}]}` instead of guessing.

## Related
`docs/brain/specs/goal-decomposition-engine.md` · `docs/brain/project-management.md` (the work hierarchy) · `docs/brain/goals/ceo-mode.md` (first goal) · `docs/brain/functions/` · skills: `build-spec` (the layer below), `probe-db`
