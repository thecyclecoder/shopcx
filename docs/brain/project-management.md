# Project management via the brain

The brain isn't just reference docs — it's also where we plan + track work. This page explains how features move from idea → spec → in-progress → shipped, and where each state lives.

## The four states

```
   ┌──────────┐    ┌──────────┐    ┌─────────────┐    ┌──────────┐
   │  IDEA    │ →  │ PLANNED  │ →  │ IN PROGRESS │ →  │ SHIPPED  │
   │ (memory) │    │  spec/   │    │   spec/     │    │ folded   │
   │          │    │          │    │ + checkmarks│    │ + spec   │
   │          │    │          │    │             │    │ deleted  │
   └──────────┘    └──────────┘    └─────────────┘    └──────────┘
```

| State | Where it lives | How you change it |
|---|---|---|
| **Idea** | An informal note in agent memory or a chat — not yet committed | Write a spec to promote it |
| **Planned** | `docs/brain/specs/{slug}.md` with all phases marked ⏳ | git add + commit the spec |
| **In progress** | Same spec file, phases marked 🚧 as they're picked up | Update the phase checkboxes as work lands |
| **Shipped** | Content folded into the relevant `lifecycles/`, `tables/`, `libraries/`, `inngest/`, `integrations/`, `recipes/`, or `dashboard/` pages. The "Status / open work" block on the lifecycle reads `Shipped:`. Spec file deleted from `specs/` | Delete the spec, update the affected pages |

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

## Folding a shipped spec into the brain

When all phases hit ✅ AND the completion criteria are met:

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
4. **Delete the spec file** — `git rm docs/brain/specs/{slug}.md`. The content lives in its permanent homes now; keeping the spec around invites drift.
5. **One PR / commit** — fold + delete + commit together. Don't leave the spec lingering "just in case." Git history is the archive.

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

[[README]] · [[customer-voice]] · [[operational-rules]] · [[specs/prompt-learning]]
