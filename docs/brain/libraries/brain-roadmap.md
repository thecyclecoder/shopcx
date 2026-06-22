# libraries/brain-roadmap

The parser that turns `docs/brain/specs/*.md` (+ `goals/`, `functions/`) into the structured data behind the [[../dashboard/roadmap|Roadmap board]], the taxonomy map, and the goal/function layer. **The markdown is the source of truth** — this reads it at request time, so editing a spec (or a build flipping a phase emoji) shows up with no DB and no drift.

**File:** `src/lib/brain-roadmap.ts`

## Why this exists

Per [[../project-management]], planning + tracking live in the brain, not a separate Kanban DB. So the board is a *projection* of the spec markdown: the `⏳ planned · 🚧 in progress · ✅ shipped · ❌ cut` phase emojis are the state. This module is the single reader/parser; everything (board, detail page, map, goals, Slack console, spec-test cron) goes through it. Read-only at request time. (Vercel prunes `docs/brain/**` unless traced — see [[../dashboard/roadmap]] § Vercel gotcha.)

## Core types

- **`SpecCard`** — one spec: `slug`, `title`, `status` (derived `Phase`), `summary`, `phases[]`, `counts`, `owner?` (function slug from `**Owner:** [[../functions/x]]`), `parent?` (mandate/goal-milestone from `**Parent:**`), **`blockedBy[]`** (prerequisite specs — see below), and **`autoBuild?`** (`false` ⇒ opted out of spec-blockers auto-queue via `**Auto-build:** off`).
- **`Phase`** = `"planned" | "in_progress" | "shipped" | "rejected"`.
- `ProjectTrack`, `RoadmapData`, `FunctionMap`/`FunctionGroup`/`ParentGroup`, `FunctionCard`/`Mandate`, `GoalCard`/`Milestone`, `ArchiveEntry`.

## Key exports

- **`getRoadmap()`** → `{ specs: SpecCard[], tracks }`. Parses every `specs/*.md` (`parseSpec`) + `specs/README.md` track chips, **resolves each spec's `blockedBy`** against the live set, sorts (in-progress → planned → shipped).
- **`getSpec(slug)`** → `{ raw, card }` for the detail page (also resolves `blockedBy`); `listSpecSlugs()`.
- **`deriveStatus`/`deriveSpecStatus(raw)`** — phase-consensus status (all-`✅` ⇒ shipped even with a stale H1; explicit `❌` title wins). Used by [[../specs/spec-test-on-ship|the on-ship hook]].
- **`getFunctionMap()`/`getFunctions()`/`getFunction()`** + `parseFunction` — the Function → Mandate/Goal → Spec taxonomy.
- **`getGoals()`/`getGoal()`** + `parseGoal`, `specCompletion` — finite goals, milestone rollup %.
- **`getArchive()`/`listArchivedSlugs()`** — verified/folded specs from `archive.d/` (← `archive.md` fallback).
- **`extractSpecSection`/`stripSpecSection`** — lift/strip a `## Heading` (the `## Verification` card, [[../specs/verification-guides]]).
- **`phaseEmoji(Phase)`** — the inverse of the internal `statusFromText`; `⏳/🚧/✅/❌`. Used by the blocker chip + the gate error.

## Spec metadata lines (parsed in `parseSpec`)

Under a spec's H1, one-per-concept bold metadata lines, each resolving `[[wikilinks]]` to slugs:

- `**Owner:** [[../functions/{slug}]]` → `owner` (the DRI function).
- `**Parent:** {mandate or goal milestone}` → `parent`.
- **`**Blocked-by:** [[spec-a]], [[spec-b]]`** → `blockedBy` (spec-blockers). Each `[[…]]` resolves to a spec slug (last path segment, alias/`.md` stripped, de-duped). Parsed exactly like Owner/Parent.

## `blockedBy` — build prerequisites ([[../specs/spec-blockers]])

`SpecCard.blockedBy: { slug, title, status, cleared }[]` — the specs that must ship before this one can be built. `parseSpec` captures the raw slugs; **`resolveBlockedBy` fills `title`/`status`/`cleared` against the live spec set** (so the board + the enqueue gate share one source of truth):

- **`cleared`** is `true` when the blocking spec's derived `status` is `shipped`, **or** the slug is no longer a live spec at all (archived/folded — it left `specs/` — or a dangling reference). A prerequisite already on `main` never permanently blocks.
- Uncleared (`planned`/`in_progress`) = still blocking.
- **`getSpecBlockers(slug)`** → the resolved `blockedBy[]` for one spec. This is what the enqueue gate ([[roadmap-actions]] `queueRoadmapBuild`) checks before inserting a build row; the [[../dashboard/roadmap|BuildButton]] renders it as the "🔒 Blocked by …" chip + disabled Build.
- **`SpecCard.autoBuild?: boolean`** (spec-blockers Phase 2 auto-queue) — `parseSpec` reads a `**Auto-build:** off` header line (like Owner/Parent); `off`/`no`/`false`/`manual`/`disabled` ⇒ `false`, any other value or no line ⇒ default on (`undefined`). When `false` the spec is **never** auto-queued as its last blocker clears (`agent-jobs.autoQueueUnblockedBy` skips it); **manual Build is unaffected**.

## Callers

`src/app/dashboard/roadmap/**` (board, `[slug]`, map, goals, functions) · `src/lib/roadmap-actions.ts` (the build gate) · `src/lib/slack-home.ts` / `slack-roadmap.ts` (Slack console) · the spec-test cron ([[../specs/spec-test-agent]]) · `src/lib/brain-links.ts`.

## Gotchas

- **No DB, no cache** — every call re-reads disk. Cheap (a few hundred small files) and always fresh.
- **`blockedBy` needs the full set** — `parseSpec` alone can't know another spec's status, so a card's `blockedBy` is only meaningful *after* `getRoadmap`/`getSpec` resolution. A raw `parseSpec(...)` (e.g. inside `deriveSpecStatus`) leaves it unresolved (all `cleared:false`); don't read `blockedBy` off that path.
- **Vercel tracing** — any route that calls these must trace `docs/brain/**` in `next.config.ts` or it reads an empty dir in prod (e.g. `/api/roadmap/build` was added for the spec-blockers gate).

## Related

[[roadmap-actions]] · [[../dashboard/roadmap]] · [[../project-management]] · [[../specs/spec-blockers]] · [[../specs/goal-decomposition-engine]] · [[../lifecycles/roadmap-build-console]]

---

[[../README]] · [[../../CLAUDE]]
