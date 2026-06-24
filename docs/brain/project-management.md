# Project management via the brain

The brain isn't just reference docs — it's also where we plan + track work. This page explains how features move from idea → spec → in-progress → shipped, and where each state lives.

## The org tiers — CEO → Directors → Agents

Three layers, mapping exactly to the supervisable-autonomy north star ([[operational-rules]] § North star) — *CEO sets objectives → role agent holds + supervises → tools execute, each loop slower and wiser than the one below*:

- **CEO** — owns company objectives (goals/BHAGs), prioritizes under constraints, arbitrates across functions, grades + coaches the directors ([[tables/director_decision_grades]]). You today → an autonomous CEO agent. The "CEO mode" ([[goals/ceo-mode]]).
- **Directors — the executive team (the C-suite).** One per **function** ([[functions/]]), each a permanent domain owner with mandates, supervising its agents and reporting to the CEO. *Director = executive, not middle management.* The **business directors** (Growth/CMO/Retention/CFO/Logistics/CS) **run** the Superfoods business; the **Platform/Engineering director (Ada, the CTO seat)** **builds** ShopCX-as-software. They are **peers** — the build-vs-business split is a lens, not a rank. Platform is the keystone (the build engine every other director ships through) but still a peer; the CEO arbitrates.
- **Agents** — the bounded autonomous tools each director owns + grades + coaches (the `agent_jobs.kind`s: Bo/build, Rafa/repair … under Platform; the storefront-optimizer … under Growth). An agent optimizes a *bounded proxy*; its director owns the *objective* and supervises it. **(Naming: "agent" is the canonical org-tier term. "Worker" / "tool" are synonyms — and `worker` persists as the internal code/table identifier, e.g. `agent_jobs.kind`, `agent_action_grades`, `coachAgent`. Same thing, one tier.)**

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
- **Optional `Blocked-by` — build prerequisites** ([[specs/spec-blockers]]). A spec that depends on another spec shipping first adds a header line `**Blocked-by:** [[spec-a]], [[spec-b]]` (parsed like Owner/Parent, [[libraries/brain-roadmap]] `parseSpec`). A blocker is **cleared** once its spec ships (or is archived/folded); until then the build enqueue chokepoint (`queueRoadmapBuild`, [[libraries/roadmap-actions]]) **refuses to queue a build** for the dependent spec and the [[dashboard/roadmap|board]] shows a "🔒 Blocked by …" chip with the Build button disabled. This formalizes the manual "queue after X merges" chaining and stops two builds colliding on the same files. Pointing `Blocked-by` at an already-shipped/archived spec is a no-op (treated as cleared). **When the *last* blocker ships, the dependent's build auto-queues itself** (`agent-jobs.autoQueueUnblockedBy`, fired from `reconcileMergedJobs` — the same merge/board-load hook spec-test uses): merge the prerequisite and the chained build fires hands-off, de-duped to one auto-queue per spec. To keep a spec manual-only, add `**Auto-build:** off` under its H1 (the auto-queue skips it; the manual Build button still works).
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
| **Planned** | `docs/brain/specs/{slug}.md` exists; the [[tables/spec_card_state]] row's `status='planned'`, every phase `planned` | git add + commit the spec |
| **In progress** | Same spec file; the DB row's phase status flips → `in_progress` as work lands. *Markdown is content-only.* | Build pipeline + drift reconciler update the DB row instantly |
| **Shipped** | Every phase in [[tables/spec_card_state]] is `shipped` — **built + deployed**. The spec file **stays** in `specs/` (the board's "Shipped — awaiting verification" column). Not yet folded. | Build merges flip the DB row; [[tables/spec_status_history]] audits who/when/why |
| **Verified** | Spec content folded into the relevant `lifecycles/`/`tables/`/`libraries/`/`inngest/`/`integrations/`/`recipes/`/`dashboard/` pages, a one-line entry appended to [[archive]], spec file `git rm`'d. The "Status / open work" block on the lifecycle reads `Shipped:`. | **Owner** clicks **Mark verified & archive** → fold-build → merge |

### Where status lives — DB, not markdown

**spec-status-db-driven** ([[specs/spec-status-db-driven]], 2026-06-24): the markdown is **content-only** (title, phase titles, owner, parent, blockedBy, autoBuild, repairSignature, summary, verification). **Status / per-phase status / critical / deferred live in [[tables/spec_card_state]] authoritatively**, with an audit row per transition in [[tables/spec_status_history]]. The board reads the DB. Every status writer (owner flip, build merge, drift reconciler, Ada drift-supervise, priority/defer) writes the DB only — zero markdown commits, zero deploys. The phase emojis you may still see in older specs are legacy noise; the [[tables/spec_card_state]] row wins.

### Shipped vs Verified — why the extra gate

**Shipped (✅)** = the build pipeline ran and deployed the code — *automated*. **Verified** = the owner tested it in production and it actually works — a *human, owner-only gate* that never automates. The gap matters: "Shipped" should be a short, honest to-do list of "live but not yet prod-verified," not a graveyard of done work. On **Verify**, durable knowledge folds into the brain (it should already be there from ship time), [[archive]] gets a browsable one-line pointer, and the spec is deleted — git history is the immutable archive. **Nothing is ever lost:** the knowledge lives in the brain pages, the archive index keeps a pointer, and a deleted spec is always `git show`-recoverable.

**The gap is pre-tested** ([[specs/spec-test-agent]]). A box QA agent runs each shipped-but-unverified spec's `## Verification` checklist for the *automatable* bullets — non-destructive checks only (repo/`tsc`, GitHub CI, Vercel deploy/logs/env, read-only DB probes, GET endpoints) — and records a [[tables/spec_test_runs]] row with a distinct **"Agent-tested ✅ / ⚠️ issues"** stamp (`agent_verdict`). The stamp is a *bounded proxy* ("the automatable parts pass") shown **next to** — never replacing — the human **Verified** state: it never marks a spec verified and never mutates prod (any mutating/visual bullet is flagged **👤 needs-human**). So the owner arrives at the verify gate evidence-backed ("8/10 auto ✅, 1 ✗ here's why, 1 👤 you eyeball it"), confirming in seconds or catching a regression first. Surfaced on the [[dashboard/roadmap|Developer → Spec Tests]] page, the board card chip, and the spec's VerificationCard. See the supervisable-autonomy north star in [[operational-rules]].

To revisit an archived feature, don't reactivate the stale spec — use **New spec from brain** (re-hydration): the authoring chat seeds Opus with the *current* brain page and drafts a *fresh* spec to extend or fix it. See [[dashboard/roadmap]] + [[lifecycles/roadmap-build-console]].

## Writing a spec

Add a file under `docs/brain/specs/{kebab-name}.md`. The spec file is the contract — it's what a `/goal` session (or a human) executes against. Template:

```markdown
# {Feature name}

**Owner:** [[../functions/{slug}]] · **Parent:** {mandate or goal-milestone}
**Blocked-by:** [[prerequisite-spec]]   ← optional; omit if nothing must ship first
**Auto-build:** off                      ← optional; opt OUT of auto-queue-on-unblock (manual Build only)

One-paragraph summary of what we're building + why. Tie it to a
business outcome.

## Phase 1 — {phase name}
- Concrete tasks, file paths, schema additions

## Phase 2 — {phase name}
- More concrete tasks

## Safety / invariants
- Non-negotiable rules (e.g. "never delete approved prompts")

## Completion criteria
- Bulleted list of what must be true for the spec to be retired

## Verification
- A concrete, prod-facing test checklist the **owner** follows to confirm the shipped
  feature actually works — the exact route / Slack action / CLI, the input, and the
  **observable expected result**. Shape: `- On {where}, {do what} → expect {observable result}.`
- e.g. `- On /dashboard/roadmap/box, queue a build → expect that lane to show the slug + a live elapsed timer.`
- **Never** vague ("test it works"). Every bullet names a concrete place + a concrete expected observation.
```

Phase status is tracked in [[tables/spec_card_state]] (DB), not the markdown. The roadmap board reads it live, no deploy needed. Phase titles + the `## Phase N` headings stay in markdown as the durable record of what was planned.

The **`## Verification` section** is the "how do I test this?" checklist ([[specs/verification-guides]]). The build that ships a spec **writes it** from the routes/tables/actions it actually touched, so a shipped spec arrives test-ready — and the spec detail page renders it as a prominent card right beside **Mark verified & archive** (the [[dashboard/roadmap]] verify gate), where the owner needs it. A shipped spec missing the section offers an owner-only **Generate test plan** button (Opus drafts one, brain-grounded). It folds into the brain with the rest of the spec on archive.

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
