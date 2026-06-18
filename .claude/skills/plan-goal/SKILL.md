---
name: plan-goal
description: Use to decompose a ShopCX company goal (or a function mandate) into a proposed milestone → spec tree, grounded in the brain — the Goal Decomposition Engine's planner pass. Reads docs/brain/goals/{slug}.md + the brain, does brain-cited gap analysis, and proposes NEW specs (each with an owner + parent) for human approval. On approval-resume, authors exactly the approved specs and queues their builds. Triggered by a kind='plan' agent_jobs job, or "plan the {slug} goal".
---

# plan-goal

Turn a **goal** into a proposed **milestone → spec tree** — one altitude above `build-spec` (which turns a spec into a PR). This is the box worker's `claude -p` driver for a `kind='plan'` [[agent_jobs]] job. The hierarchy is **Function → (Mandate | Goal) → Spec** (docs/brain/project-management.md).

## 🔒 Core invariant — propose, never dispose

**The planner proposes; the human disposes.** Your plan pass NEVER writes a spec file and NEVER queues a build. You emit a *proposed* tree for the owner to approve branch-by-branch. Only on the **approval-resume** pass — after the owner has approved specific branches — do you author exactly those specs. Two gates total: approve-tree, then (later) merge-PR. Use your own native tools; never spawn a nested `claude`.

## Pass A — the plan pass (job claimed, no approvals yet)

1. **Read the goal.** `docs/brain/goals/{slug}.md` — its **outcome**, **success metric**, **target**, `## Current state`, and `## Decomposition` (the target milestone shape). A `functions/{slug}.md` **mandate** can be the input instead — same procedure.
2. **Ground in the brain — current-state model.** For the success metric, work out what capabilities / data / integrations ALREADY exist vs. are MISSING. Read the real pages: start at `docs/brain/README.md`, then `tables/`, `inngest/`, `integrations/`, `libraries/`, `lifecycles/`. **Every "we already have X" and every "X is a gap" claim MUST cite the brain page that proves it** (e.g. `[[../integrations/meta-graph]]`, "no Amazon page → gap"). No hallucinated current-state.
3. **Propose the tree.** For each milestone, each **leaf** is either:
   - an **existing** spec (`[[../specs/{slug}]]`) that already covers it — reference it, don't re-propose; or
   - a **NEW** spec to author — give it: a **title**, a one-paragraph **intent**, the **brain gap it closes** (cited), and — mandatory — an **owner** (exactly one `functions/{slug}`, the DRI) and a **parent** (a function mandate or a goal milestone).
4. **Reject your own orphans.** Every proposed NEW spec MUST name both an owner function and a parent. If you can't place one, don't propose it.
5. **Don't recurse.** A plan pass is ONE bounded run. A milestone that's still too big to be a single spec is proposed as a **sub-goal** (`type:'spec'` with intent "author a `goals/{slug}.md` sub-goal") for a future, separately-approved plan pass — not decomposed further now.
6. **Re-plan:** if the job instructions say RE-PLAN, propose ONLY newly-revealed gaps. Do not re-propose any branch already shipped (✅) or declined (❌) in the goal doc's Decomposition, and never touch approved/in-flight branches.
7. **Emit the tree for approval — final JSON only:**
   ```json
   {"status":"needs_approval","actions":[
     {"type":"spec","specSlug":"metrics-spine","summary":"Metrics spine + COGS — owner: cfo · parent: CEO-mode M1","preview":"One-paragraph intent. Closes the gap: no unifying metrics store (brain has order-level revenue in tables/orders but no P&L/margin spine) + no COGS/landed-cost page."}
   ]}
   ```
   One action **per proposed branch**. `specSlug` = the kebab slug the spec will live at. `summary` = title + `owner:` + `parent:`. `preview` = the intent + the cited brain gap. Stop here — the worker pauses the job at `needs_approval`.

## Pass B — the author-resume pass (owner approved branches)

The worker resumes your session and tells you exactly which branches were **approved** vs **declined**. For each **approved** branch:

1. **Author the spec** at `docs/brain/specs/{specSlug}.md` using the SAME shape as the authoring chat: H1 `# <Title> ⏳`, the metadata line directly under it — `**Owner:** [[../functions/{owner}]] · **Parent:** {the mandate or goal milestone}` — a one-paragraph outcome, concrete `## Phase N — name` sections (each line ⏳), `## Safety / invariants`, `## Completion criteria`. Ground it in the brain you cited. No orphans: owner + parent are mandatory.
2. **Wikilink it into the goal/function doc.** In `docs/brain/goals/{slug}.md` `## Decomposition`, add `[[../specs/{specSlug}]]` under its milestone (create the milestone bullet if needed). If the parent is a function mandate, add it under that mandate in `functions/{owner}.md` instead.
3. **Record declined branches** in the goal doc with ❌ so a future re-plan doesn't re-propose them.
4. **Do NOT build.** You only author specs + the doc updates. The worker inserts the `kind='build'` jobs (it has the DB creds); each build then opens its own `claude/*` PR the owner merges.
5. **Gate + finish — final JSON only:**
   ```json
   {"status":"completed","summary":"authored 2 specs; declined 1","authored":["metrics-spine","cogs-supplier"]}
   ```
   `authored` = the spec slugs you actually wrote (the worker queues a build for each). Run `npx tsc --noEmit` if you touched any `.ts` (you normally won't — docs only).

## Safety / invariants

- **Grounded in the brain** — every current-state claim cites a brain page. No hallucinated gaps.
- **No orphan specs** — every proposed/authored spec declares one owner function + a parent.
- **Planner never builds** — Pass A proposes; Pass B authors approved specs only; builds are separate `kind='build'` jobs → PRs the owner merges.
- **One bounded pass** — too-big milestones become sub-goals, not autonomous recursion.

## Related
docs/brain/specs/goal-decomposition-engine.md · [[agent_jobs]] · skills: `build-spec`, `write-migration` · `docs/brain/project-management.md` · `scripts/builder-worker.ts`
