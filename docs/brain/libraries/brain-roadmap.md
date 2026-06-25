# libraries/brain-roadmap

The parser that turns `docs/brain/specs/*.md` (+ `goals/`, `functions/`) into the structured data behind the [[../dashboard/roadmap|Roadmap board]], the taxonomy map, and the goal/function layer. **The markdown is the source of truth for CONTENT** (title, phase titles, owner, parent, blockedBy, autoBuild, repairSignature, summary, verification). **Status / per-phase status / critical / deferred live in the DB** ([[../tables/spec_card_state]], authoritatively — [[../specs/spec-status-db-driven]] Phase 1). `getRoadmap(workspaceId)` / `getSpec(slug, workspaceId)` / `getFunctionMap(workspaceId)` / `getGoals(workspaceId)` overlay the DB state onto every `SpecCard` — so a board flip lands the moment a writer touches `spec_card_state` (no deploy needed, no GitHub call). Older callers without a workspaceId still get the markdown-derived fallback.

**File:** `src/lib/brain-roadmap.ts`

## Why this exists

Per [[../project-management]], planning + tracking live in the brain, not a separate Kanban DB. So the board is a *projection* of the spec markdown: the `⏳ planned · 🚧 in progress · ✅ shipped · ❌ cut` phase emojis are the state. This module is the single reader/parser; everything (board, detail page, map, goals, Slack console, spec-test cron) goes through it. Read-only at request time. (Vercel prunes `docs/brain/**` unless traced — see [[../dashboard/roadmap]] § Vercel gotcha.)

## Core types

- **`SpecCard`** — one spec: `slug`, `title`, `status` (derived `SpecStatus`), `summary`, `phases[]`, `counts`, `owner?` (function slug from `**Owner:** [[../functions/x]]`), `parent?` (mandate/goal-milestone from `**Parent:**`), **`blockedBy[]`** (prerequisite specs — see below), and **`autoBuild?`** (`false` ⇒ opted out of spec-blockers auto-queue via `**Auto-build:** off`).
- **`Phase`** = `"planned" | "in_progress" | "shipped" | "rejected"` — a **phase-level** status (`SpecPhase.status`, `counts`).
- **`SpecStatus`** = `Phase | "deferred"` — the **whole-spec** board status ([[../specs/director-drives-all-specs-and-deferred-status]] Phase 1). `deferred` is orthogonal to phase progress: `parseSpec` flags it from a leading `**Deferred:**` metadata line (already authored by [[board-grooming]] split cards) **or** `**Status:** deferred`, and `deriveStatus` returns `"deferred"` over any ⏳ phases. A deferred spec gets its **own board column** and is **excluded by every auto-build lane** ([[platform-director]]) until the CEO removes the marker (un-defers → Planned). Detection is **anchored to line-start** so a prose/backtick mention of the marker is not a false positive. Phases are never `deferred` (no emoji maps to it).
- `ProjectTrack`, `RoadmapData`, `FunctionMap`/`FunctionGroup`/`ParentGroup`, `FunctionCard`/`Mandate`, `GoalCard`/`Milestone`, `ArchiveEntry`.

## Key exports

- **`getRoadmap()`** → `{ specs: SpecCard[], tracks }`. Parses every `specs/*.md` (`parseSpec`) + `specs/README.md` track chips, **resolves each spec's `blockedBy`** against the live set, sorts (in-progress → planned → shipped).
- **`getSpec(slug)`** → `{ raw, card }` for the detail page (also resolves `blockedBy`); `listSpecSlugs()`.
- **`deriveStatus`/`deriveSpecStatus(raw)`** → `SpecStatus` — a leading `**Deferred:**` / `**Status:** deferred` marker wins (`deferred`); else phase-consensus status (all-`✅` ⇒ shipped even with a stale H1; explicit `❌` title wins). Used by [[../specs/spec-test-on-ship|the on-ship hook]].
- **`getFunctionMap()`/`getFunctions()`/`getFunction()`** + `parseFunction` — the Function → Mandate/Goal → Spec taxonomy.
- **`getGoals()`/`getGoal()`** + `parseGoal`, `specCompletion` — finite goals, milestone rollup %. `GoalCard.owner?` is the DRI function slug parsed from the goal's `Owner: [[../functions/x]]` line (bold or plain) — the canonical goal→function link the Platform/DevOps Director escort uses to pick the goals it owns ([[platform-director]] Phase 2).
- **`GoalCard.status`** (`proposed｜greenlit｜complete`) + **`GoalCard.proposedBy?`** + **`deriveGoalStatus(rawStatus, pct)`** ([[../specs/director-proposed-goals]] Phase 1) — the goal's **explicit lifecycle state**, parsed from a `**Status:**` line. `proposed` = a director authored it and it AWAITS the CEO's greenlight (inert: the escort skips it, Pia doesn't decompose it); `greenlit` = CEO-approved/active; `complete` = 100%. An **explicit marker wins**; a legacy goal with no `**Status:**` line is `complete` at 100% else `greenlit` — so a `proposed` 0% goal is now unambiguously distinct from an active 0% one (replacing the old `pct > 0`-infers-greenlit hack the escort used). `proposedBy` is the proposing function from a `**Proposed-by:** [[../functions/x]]` marker (present only on a director-proposed artifact). See [[goal-proposals]].
- **`getRoadmapFilters()`** → `{ goals, goalsBySpec, sourceBySpec }` for the board's goal + source filters ([[../specs/roadmap-goal-and-source-filters]]). **Goal membership** = the union of each goal doc's `[[spec]]` wikilinks (the reliable planner signal) and any spec whose `**Parent:**` references the goal (its slug, title, or a milestone of it). **`SpecSource`** = `repair` (the spec has a `**Repair-signature:**` line — `parseSpec` derives `SpecCard.repairSignature`), else `goal` (wikilinked from a goal doc — wikilink only, not parent-match), else `manual`. No schema change — all derived from the existing markdown.
- **`getArchive()`/`listArchivedSlugs()`** — verified/folded specs from `archive.d/` (← `archive.md` fallback).
- **`extractSpecSection`/`stripSpecSection`** — lift/strip a `## Heading` (the `## Verification` card, [[../specs/verification-guides]]).
- **`phaseEmoji(Phase)`** — the inverse of the internal `statusFromText`; `⏳/🚧/✅/❌`. Used by the blocker chip + the gate error.

## Live status — DB-authoritative ([[spec-card-state]], [[../specs/spec-status-db-driven]])

The board reads the **bundled `fs` copy** for content + the **[[../tables/spec_card_state]] DB** for status. `getRoadmap(workspaceId)` overlays the DB row onto every `SpecCard`, and status / `flags.critical` / `flags.deferred` / `phase_states` come from the DB authoritatively. (The prior request-time git-read approach — `roadmap-reads-specs-from-git` — was tried and retired; per-request SHA polling burned the GitHub core quota.)

- **The DB is written instantly** on every status event: a build merge ([[agent-jobs]] `reconcileMergedJobs` → `markSpecCardMergeShipped`), a drift flip ([[spec-drift]] `reconcileSpecDrift`), an owner status flip (`/api/roadmap/status`), a one-tap drift flip (`/api/roadmap/spec-drift`), an owner priority/defer (`/api/roadmap/priority`), Ada's drift-supervise. Each writes `spec_card_state` + an audit row to [[../tables/spec_status_history]] the moment it happens — zero markdown commits, zero deploys, zero GitHub API calls for status ([[../specs/spec-status-db-driven]] Phase 2).
- **The board reads DB-only.** [[../dashboard/roadmap]] calls `getRoadmap(workspaceId)`; the overlay merges `spec_card_state` into each card before sorting columns. A spec with no DB row defaults to `planned` (the merge-write auto-creates a row, and the backfill seeded existing specs).
- **`flags.deferred` wins over phase progress.** A `flags.deferred=true` card renders in the Deferred column regardless of `status` rollup. Un-defer restores phase progress (the rollup is recomputed from `phase_states`).
- **Code-deploy chip.** `last_merge_sha` is compared to `VERCEL_GIT_COMMIT_SHA` (`deploymentState`) to show **`shipped · deploying`** until a deployment carrying that SHA is live, then **`shipped · live`** — this tracks code, not status (status writes no longer trigger deploys).

## Spec metadata lines (parsed in `parseSpec`)

Under a spec's H1, one-per-concept bold metadata lines, each resolving `[[wikilinks]]` to slugs:

- `**Owner:** [[../functions/{slug}]]` → `owner` (the DRI function).
- `**Parent:** {mandate or goal milestone}` → `parent`.
- `**Repair-signature:** \`…\`` → `repairSignature` (boolean; box-Repair-Agent-authored specs only). Drives the board's "🔧 Repair" source chip via [[#Key exports|getRoadmapFilters]].
- **`**Blocked-by:** [[spec-a]], [[spec-b]]`** → `blockedBy` (spec-blockers). Each `[[…]]` resolves to a spec slug (last path segment, alias/`.md` stripped, de-duped). Parsed exactly like Owner/Parent.
- **`**Priority:** critical`** → `flags.critical` (boolean; line-anchored marker). A spec carrying this metadata is prioritized in build queues ahead of normal Planned specs. Set by Ada via a `spec-edit` card or a CEO-approved directive's `criticalSpecs` list. Orthogonal to phase progress: a `critical` spec can be in any phase. The `spec-status` card auto-applies this field (no CEO inbox approval).

## `blockedBy` — build prerequisites ([[../specs/spec-blockers]])

`SpecCard.blockedBy: { slug, title, status, cleared }[]` — the specs that must ship before this one can be built. `parseSpec` captures the raw slugs; **`resolveBlockedBy` fills `title`/`status`/`cleared` against the live spec set** (so the board + the enqueue gate share one source of truth):

- **`cleared`** is `true` when the blocking spec's derived `status` is `shipped`, **or** the slug is no longer a live spec at all (archived/folded — it left `specs/` — or a dangling reference). A prerequisite already on `main` never permanently blocks.
- Uncleared (`planned`/`in_progress`) = still blocking.
- **`getSpecBlockers(slug)`** → the resolved `blockedBy[]` for one spec. This is what the enqueue gate ([[roadmap-actions]] `queueRoadmapBuild`) checks before inserting a build row; the [[../dashboard/roadmap|BuildButton]] renders it as the "🔒 Blocked by …" chip + disabled Build.
- **`SpecCard.autoBuild?: boolean`** (spec-blockers Phase 2 auto-queue) — `parseSpec` reads a `**Auto-build:** off` header line (like Owner/Parent); `off`/`no`/`false`/`manual`/`disabled` ⇒ `false`, any other value or no line ⇒ default on (`undefined`). When `false` the spec is **never** auto-queued as its last blocker clears (`agent-jobs.autoQueueUnblockedBy` skips it); **manual Build is unaffected**.

## Callers

`src/app/dashboard/roadmap/**` (board, `[slug]`, map, goals, functions) · `src/lib/roadmap-actions.ts` (the build gate) · the spec-test cron ([[../specs/spec-test-agent]]) · `src/lib/brain-links.ts`.

## Gotchas

- **This parser has no DB** — it reads only the bundled markdown on disk (a few hundred small files, cheap). The *live status overlay* lives in a separate DB table ([[spec-card-state]] → [[../tables/spec_card_state]]); the board composes the two. The goals/functions loaders read the bundled disk copy each call.
- **`blockedBy` needs the full set** — `parseSpec` alone can't know another spec's status, so a card's `blockedBy` is only meaningful *after* `getRoadmap`/`getSpec` resolution. A raw `parseSpec(...)` (e.g. inside `deriveSpecStatus`) leaves it unresolved (all `cleared:false`); don't read `blockedBy` off that path.
- **Vercel tracing** — any route that calls these must trace `docs/brain/**` in `next.config.ts` or it reads an empty dir in prod (e.g. `/api/roadmap/build` was added for the spec-blockers gate).

## Related

[[roadmap-actions]] · [[spec-card-state]] · [[../tables/spec_card_state]] · [[../dashboard/roadmap]] · [[../project-management]] · [[../specs/spec-blockers]] · [[../specs/goal-decomposition-engine]] · [[../lifecycles/roadmap-build-console]]

---

[[../README]] · [[../../CLAUDE]]
