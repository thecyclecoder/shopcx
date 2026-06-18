# Project management via the brain

The brain isn't just reference docs — it's also where we plan + track work. This page explains how features move from idea → spec → in-progress → shipped, and where each state lives.

## The work hierarchy — no orphan specs

Every spec belongs to something bigger; the parent chain terminates at the org chart.

```
Function (Growth, CMO, Retention, CFO, Logistics, CS, Platform/Eng)   functions/{slug}.md — permanent owner
  ├─ Mandate  (perpetual charter, metric-tracked, never "done")
  │     └─ Spec → Phase → Build
  └─ Goal     (finite BHAG, rolls up to 100% then closes)   goals/{slug}.md
        └─ Milestone
              └─ Spec → Phase → Build
```

- **Functions** (`docs/brain/functions/`) are the **permanent skeleton** — one per org-chart director. Each owns perpetual mandates and the specs/goals under them. A function doc doubles as the CEO-mode director-agent's charter ([[goals/ceo-mode]]).
- **Two kinds of parent.** A **mandate** is *perpetual* — a standing charter a function owns forever (e.g. Growth's "static-ad optimization"); it never finishes, is measured by a metric trend, and keeps emitting specs. A **goal** (`docs/brain/goals/`) is *finite* — it has a finish line, decomposes into milestones, and closes at 100%. Don't model a perpetual charter as a goal.
- **Every spec declares an `owner` + `parent`.** Owner = exactly one function (the DRI — single-threaded ownership, even for shared work, with optional "contributes-to" links). Parent = a function mandate or a goal milestone. A metadata line under the spec's H1: `**Owner:** [[../functions/{slug}]] · **Parent:** {mandate or goal-milestone}`.
- **No orphans.** A spec with no owner/parent is incomplete. The [[specs/goal-decomposition-engine|goal-decomposition engine]] enforces this when the planner proposes specs; a board lint flags any existing orphan. Worked example: [[functions/growth]] owns [[specs/winning-static-creative-finder]] under its static-ad mandate.

This hierarchy is operationalized by the [[specs/goal-decomposition-engine|goal-decomposition engine]]: write a goal (or point at a mandate), the planner gap-analyzes against the brain and proposes owner/parent-tagged specs, you approve the branches, and the existing build pipeline ships them.

## The five states

```
   ┌──────────┐   ┌──────────┐   ┌─────────────┐   ┌──────────┐   ┌──────────┐
   │  IDEA    │ → │ PLANNED  │ → │ IN PROGRESS │ → │ SHIPPED  │ → │ VERIFIED │
   │ (memory) │   │  spec/   │   │   spec/     │   │ built +  │   │ folded + │
   │          │   │  all ⏳  │   │ phases 🚧   │   │ deployed │   │ archived │
   │          │   │          │   │             │   │  (✅)    │   │ spec rm  │
   └──────────┘   └──────────┘   └─────────────┘   └──────────┘   └──────────┘
```

| State | Where it lives | How you change it |
|---|---|---|
| **Idea** | An informal note in agent memory or a chat — not yet committed | Write a spec to promote it |
| **Planned** | `docs/brain/specs/{slug}.md` with all phases marked ⏳ | git add + commit the spec |
| **In progress** | Same spec file, phases marked 🚧 as they're picked up | Update the phase checkboxes as work lands |
| **Shipped** | All phases ✅ in `specs/{slug}.md` — **built + deployed**, stamped automatically by the build pipeline. The spec **stays** in `specs/` (the board's "Shipped — awaiting verification" column). Not yet folded. | Mark phases ✅ as builds land |
| **Verified** | Spec content folded into the relevant `lifecycles/`/`tables/`/`libraries/`/`inngest/`/`integrations/`/`recipes/`/`dashboard/` pages, a one-line entry appended to [[archive]], spec file `git rm`'d. The "Status / open work" block on the lifecycle reads `Shipped:`. | **Owner** clicks **Mark verified & archive** → fold-build → merge |

### Shipped vs Verified — why the extra gate

**Shipped (✅)** = the build pipeline ran and deployed the code — *automated*. **Verified** = the owner tested it in production and it actually works — a *human, owner-only gate* that never automates. The gap matters: "Shipped" should be a short, honest to-do list of "live but not yet prod-verified," not a graveyard of done work. On **Verify**, durable knowledge folds into the brain (it should already be there from ship time), [[archive]] gets a browsable one-line pointer, and the spec is deleted — git history is the immutable archive. **Nothing is ever lost:** the knowledge lives in the brain pages, the archive index keeps a pointer, and a deleted spec is always `git show`-recoverable.

To revisit an archived feature, don't reactivate the stale spec — use **New spec from brain** (re-hydration): the authoring chat seeds Opus with the *current* brain page and drafts a *fresh* spec to extend or fix it. See [[dashboard/roadmap]] + [[lifecycles/roadmap-build-console]].

## Writing a spec

Add a file under `docs/brain/specs/{kebab-name}.md`. The spec file is the contract — it's what a `/goal` session (or a human) executes against. Template:

```markdown
# {Feature name}

One-paragraph summary of what we're building + why. Tie it to a
business outcome.

## Phase 1 — {phase name}
- ⏳ planned (or 🚧 in progress, or ✅ shipped)
- Concrete tasks, file paths, schema additions

## Phase 2 — {phase name}
- ⏳ planned

## Safety / invariants
- Non-negotiable rules (e.g. "never delete approved prompts")

## Completion criteria
- Bulleted list of what must be true for the spec to be retired
```

The phase emoji convention (⏳ 🚧 ✅) keeps progress visible at a glance — no separate Kanban needed. Anyone reading the spec sees what's done + what's next inline.

## Kicking off a build session

Once the spec is in `specs/`, start a new Claude Code session and fire:

```
/goal do everything in docs/brain/specs/{slug}.md
```

The session reads the spec, executes the phases, and stops when the completion criteria are met. As phases land, the agent commits AND updates the spec's phase emojis from ⏳ → 🚧 → ✅. Each commit is its own PR-equivalent so progress is visible in git history too.

## Folding a shipped spec into the brain (on Verify)

This is the **Verified** transition — `shipped → verified → fold + delete + archive-index`. It fires when the **owner** marks a shipped spec **verified** (Mark verified & archive on the board), which queues a **fold-build**. When all phases hit ✅, the completion criteria are met, AND the owner has confirmed it works in production:

1. **Fold the content into existing brain pages** — every concept the spec introduced gets a permanent home:
   - New tables → `tables/{name}.md`
   - New Inngest functions → `inngest/{name}.md`
   - New library files → `libraries/{name}.md`
   - New external API → `integrations/{name}.md`
   - End-to-end flow → `lifecycles/{name}.md` with a "Status / open work" section reading `Shipped: ...`
   - Common operational moves → `recipes/{name}.md`
   - Dashboard surfaces → `dashboard/{route}.md`
   - Cross-cutting rules → `customer-voice.md` / `operational-rules.md` / `ui-conventions.md` / `orchestrator-tools.md`
2. **Cross-link** — every new page wikilinks 3-5 related pages and is wikilinked FROM at least one existing page (so the brain stays navigable).
3. **Update the README** — `README.md` folder counts + the Core/Tickets/AI/etc. category lists if any table moved into them.
4. **Append to the archive index** — add one line to [[archive]]'s `## Index` list (newest-first): `- **{Title}** · verified {YYYY-MM-DD} · → [[lifecycles/{slug}]]`. This is the browsable pointer the board's **Archived** section reads.
5. **Delete the spec file** — `git rm docs/brain/specs/{slug}.md`. The content lives in its permanent homes now; keeping the spec around invites drift.
6. **One PR / commit** — fold + archive-index + delete + commit together. Don't leave the spec lingering "just in case." Git history is the immutable archive; a deleted spec is always `git show`-recoverable.

## The "Status / open work" pattern on lifecycle pages

Every `lifecycles/*.md` page ends with this block before the Related section:

```markdown
## Status / open work

**Shipped:** {one-sentence summary of the happy path that's actually
end-to-end wired}

**Known gaps / not yet shipped:**
- {bullet} {evidence — file path or comment}

**Recent activity:**
- {hash} {commit subject — last 1-3 commits touching this area}

**Open questions:** {bullets, or "None"}
```

This is where "current state" lives for SHIPPED features. The spec format covers PLANNED features. Together they answer:

- "Is X built?" → check the lifecycle's Status block
- "Is X planned but not built?" → look in `specs/`
- "Is X being worked on right now?" → spec phase emoji + recent commits in Status block

## Memory vs brain

| Use memory for | Use brain for |
|---|---|
| Dylan's preferences / how he likes to collaborate | Project rules, architecture, in-flight specs |
| Historical incident context that's specific to one Claude session | Anything another agent / human / future me needs to see |
| Ephemeral session state (current task, where I left off) | Decisions that should survive cold starts |

Per `CLAUDE.md`: **every new feature / table / Inngest function / integration / library file must land in `docs/brain/` in the same PR.** Code without a brain page is incomplete. Memory is for Dylan-specific collaboration context; the brain is for the project.

When a spec is in `specs/` and Dylan asks "where did we leave off on X" in a new session, the agent reads:
1. `specs/{slug}.md` — phase emojis show the build state
2. Recent git log on files mentioned in the spec — confirms what actually landed
3. Lifecycle "Status / open work" blocks for any folded content

That triplet answers "what's done, what's next, what's blocked" without Dylan having to brief from scratch.

## Related

[[README]] · [[archive]] · [[dashboard/roadmap]] · [[lifecycles/roadmap-build-console]] · [[customer-voice]] · [[operational-rules]] · [[lifecycles/ai-learning]] (example of a shipped + folded spec)
