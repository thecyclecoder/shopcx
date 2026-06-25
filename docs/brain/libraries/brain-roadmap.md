# libraries/brain-roadmap

**DB-first spec + goal/function loaders** (2026-06-24). `getRoadmap(workspaceId)` / `getSpec(slug, workspaceId)` / `getFunctionMap(workspaceId)` / `getGoals(workspaceId)` read from `[[../tables/specs]]` + `[[../tables/spec_phases]]` (spec content + status) + the markdown (goal/function content). **Spec content** (title, phase titles, owner, parent, blockedBy, autoBuild, repairSignature, summary) is **now DB-authoritative** ([[spec-body-table-and-backfill]]); **goal/function content stays in markdown** (goals/, functions/). The [[../dashboard/roadmap|Roadmap board]], taxonomy map, and detail pages all read the DB — a board flip lands the moment a writer touches `[[../tables/spec_card_state]]` (no deploy needed). Legacy code paths that parsed `docs/brain/specs/*.md` with `parseSpec` / `overlayDbStateOnSpec` have been retired ([[../specs/spec-readers-from-db-retire-parser]]); the reader surfaces (board, detail page, Slack, spec-test agent) all read the DB.

**File:** `src/lib/brain-roadmap.ts`

## Why this exists

The [[../dashboard/roadmap|Roadmap board]], goal/function maps, and detail pages all project a single unified view of the planning state: specs (from `public.specs` + `public.spec_phases`), goals (from `docs/brain/goals/*.md`), and functions (from `docs/brain/functions/*.md`). This module is the single loader for all three. Read-only at request time.

## Core types

- **`SpecCard`** — one spec: `slug`, `title`, `status` (derived `SpecStatus`), `summary`, `phases[]`, `counts`, `owner?` (function slug from `**Owner:** [[../functions/x]]`), `parent?` (mandate/goal-milestone from `**Parent:**`), **`blockedBy[]`** (prerequisite specs — see below), and **`autoBuild?`** (`false` ⇒ opted out of spec-blockers auto-queue via `**Auto-build:** off`).
- **`Phase`** = `"planned" | "in_progress" | "shipped" | "rejected"` — a **phase-level** status (`SpecPhase.status`, `counts`).
- **`SpecStatus`** = `Phase | "deferred"` — the **whole-spec** board status ([[../specs/director-drives-all-specs-and-deferred-status]] Phase 1). `deferred` is orthogonal to phase progress: `parseSpec` flags it from a leading `**Deferred:**` metadata line (already authored by [[board-grooming]] split cards) **or** `**Status:** deferred`, and `deriveStatus` returns `"deferred"` over any ⏳ phases. A deferred spec gets its **own board column** and is **excluded by every auto-build lane** ([[platform-director]]) until the CEO removes the marker (un-defers → Planned). Detection is **anchored to line-start** so a prose/backtick mention of the marker is not a false positive. Phases are never `deferred` (no emoji maps to it).
- `ProjectTrack`, `RoadmapData`, `FunctionMap`/`FunctionGroup`/`ParentGroup`, `FunctionCard`/`Mandate`, `GoalCard`/`Milestone`, `ArchiveEntry`.

## Key exports

- **`getRoadmap(workspaceId)`** → `{ specs: SpecCard[], tracks }`. Reads `public.specs` + `public.spec_phases` ordered by position, **resolves each spec's `blockedBy`** against the live set, overlays `[[../tables/spec_card_state]]` for live status, sorts (in-progress → planned → shipped → deferred).
- **`getSpec(slug, workspaceId)`** → `{ raw, card }` for the detail page (also resolves `blockedBy`, overlays status). **`raw` is the markdown copy** (lifecycle/content view), **`card` is the DB row + overlay** (live state).
- **`getFunctionMap(workspaceId)`/`getFunctions(workspaceId)`/`getFunction(slug, workspaceId)`** + `parseFunction` — the Function → Mandate/Goal → Spec taxonomy (goals + functions still read markdown).
- **`getGoals(workspaceId)`/`getGoal(slug, workspaceId)`** + `parseGoal`, `specCompletion` — finite goals, milestone rollup %. `GoalCard.owner?` is the DRI function slug parsed from the goal's `Owner: [[../functions/x]]` line (bold or plain) — the canonical goal→function link the Platform/DevOps Director escort uses to pick the goals it owns ([[platform-director]] Phase 2).
- **`GoalCard.status`** (`proposed｜greenlit｜complete`) + **`GoalCard.proposedBy?`** + **`deriveGoalStatus(rawStatus, pct)`** ([[../specs/director-proposed-goals]] Phase 1) — the goal's **explicit lifecycle state**, parsed from a `**Status:**` line. See [[goal-proposals]].
- **`getRoadmapFilters()`** → `{ goals, goalsBySpec, sourceBySpec }` for the board's goal + source filters ([[../specs/roadmap-goal-and-source-filters]]). **`SpecSource`** = `repair` (the spec has a `**Repair-signature:**` metadata line from [[../tables/specs]]), else `goal` (wikilinked from a goal doc), else `manual`.
- **`getArchive()`/`listArchivedSlugs()`** — verified/folded specs from `archive.d/` (← `archive.md` fallback).
- **`phaseEmoji(Phase)`** → `⏳/🚧/✅/❌`. Used by the blocker chip + status cards.

## Spec status & content — DB-authoritative ([[../tables/spec_card_state]], [[../specs/spec-status-db-driven]])

Spec **content** (title, phases, owner, parent, blockedBy, repairSignature, summary) and **status** (planned/in-progress/shipped/rejected/deferred) are both **DB-authoritative**. `getRoadmap(workspaceId)` reads `public.specs` + `public.spec_phases` + `[[../tables/spec_card_state]]` (status, `flags.critical`, `flags.deferred`); the board renders DB state directly. A spec with no `spec_card_state` row defaults to `planned` (the merge-write auto-creates a row; the backfill seeded existing specs).

- **The DB is written instantly** on every status event: a build merge ([[agent-jobs]] `reconcileMergedJobs`), an owner status flip (`/api/roadmap/status`), an owner priority/defer (`/api/roadmap/priority`), Ada's drift-supervise ([[../specs/ada-director-spec-status-cards]]). Each writes `spec_card_state` + an audit row to [[../tables/spec_status_history]] — zero markdown commits, zero deploys, zero GitHub API calls ([[../specs/spec-status-db-driven]] Phase 2).
- **`flags.deferred` wins over phase progress.** A `flags.deferred=true` card renders in the Deferred column regardless of `status` rollup. Un-defer restores phase progress.
- **Code-deploy chip.** `last_merge_sha` is compared to `VERCEL_GIT_COMMIT_SHA` to show **`shipped · deploying`** until live, then **`shipped · live`** — this tracks code, not status (status writes no longer trigger deploys).

## Spec content — `[[../tables/specs]]` schema

Spec metadata is **DB-stored** ([[spec-body-table-and-backfill]]). The `getSpec(slug, workspaceId)` query reads:

- **`specs` table columns:** `slug`, `title`, `status`, `summary`, `owner_id` (FK → function), `parent_id` (FK → goal/milestone), `blocked_by` (JSON array of spec slugs), `auto_build`, `repair_signature`
- **`spec_phases` table:** per-phase content `(index, title, status, pr, merge_sha, body)` ordered by position. `status` is `planned | in_progress | shipped | rejected`.
- **`spec_card_state` table:** live flags (`critical`, `deferred`, `blocked`, `deploy_pending`) and merged build provenance (`last_merge_sha`, `phase_states`).

Goal/function metadata **still live in markdown** (see [[#Spec metadata lines|Goal/function metadata below]]).

## Goal / function metadata lines (parsed in `parseGoal` / `parseFunction`)

Goals + functions still read from markdown. Under a doc's H1, one-per-concept bold metadata lines:

- `**Owner:** [[../functions/{slug}]]` → `owner` (the DRI function).
- `**Status:** proposed | greenlit | complete` (goals only) → explicit lifecycle state.
- `**Proposed-by:** [[../functions/{slug}]]` (goals only) → proposing director.

## `blockedBy` — spec build prerequisites ([[../specs/spec-blockers]])

`SpecCard.blockedBy: { slug, title, status, cleared }[]` — the specs that must ship before this one can be built. `specs.blocked_by` (from the DB) provides the raw slugs; **`resolveBlockedBy` fills `title`/`status`/`cleared` against the live spec set**:

- **`cleared`** is `true` when the blocking spec's derived `status` is `shipped`, **or** the slug is no longer a live spec at all (archived/folded or dangling). A prerequisite already on `main` never permanently blocks.
- Uncleared (`planned`/`in_progress`) = still blocking.
- **`getSpecBlockers(slug)`** → the resolved `blockedBy[]` for one spec. What the enqueue gate ([[roadmap-actions]] `queueRoadmapBuild`) checks before inserting a build row.
- **`SpecCard.autoBuild?: boolean`** (spec-blockers Phase 2 auto-queue) — `specs.auto_build` (DB column, boolean). When `false` the spec is **never** auto-queued as its last blocker clears; **manual Build is unaffected**.

## Callers

`src/app/dashboard/roadmap/**` (board, `[slug]`, map, goals, functions) · `src/lib/roadmap-actions.ts` (the build gate) · the spec-test cron ([[../specs/spec-test-agent]]) · `src/lib/brain-links.ts`.

## Gotcha

- **`blockedBy` needs the full set** — `getSpec(slug)` alone can't resolve whether a blocker has cleared, so a card's `blockedBy` is only meaningful *after* `getRoadmap` (which loads all specs). A single `getSpec` call leaves `cleared:false` for all; the board uses `getRoadmap` so all specs resolve together.

## Related

[[roadmap-actions]] · [[spec-card-state]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../tables/spec_card_state]] · [[../dashboard/roadmap]] · [[../project-management]] · [[../specs/spec-blockers]] · [[../specs/goal-decomposition-engine]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../lifecycles/roadmap-build-console]]

---

[[../README]] · [[../../CLAUDE]]
