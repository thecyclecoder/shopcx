# libraries/brain-roadmap

The parser that turns `docs/brain/specs/*.md` (+ `goals/`, `functions/`) into the structured data behind the [[../dashboard/roadmap|Roadmap board]], the taxonomy map, and the goal/function layer. **The markdown is the source of truth** — this reads the **bundled `fs` copy** at request time and parses the `⏳/🚧/✅` phase emojis. The *live* project-management state (instant status + the deploy-pending flag) is layered on top by the [[spec-card-state]] DB mirror, so a merge / drift flip / owner mark shows on the board instantly without waiting for the next deploy — **no GitHub API calls for status** (the retired request-time git-read approach burned the quota; see [[../tables/spec_card_state]]).

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
- **`getGoals()`/`getGoal()`** + `parseGoal`, `specCompletion` — finite goals, milestone rollup %. `GoalCard.owner?` is the DRI function slug parsed from the goal's `Owner: [[../functions/x]]` line (bold or plain) — the canonical goal→function link the Platform/DevOps Director escort uses to pick the goals it owns ([[platform-director]] Phase 2).
- **`GoalCard.status`** (`proposed｜greenlit｜complete`) + **`GoalCard.proposedBy?`** + **`deriveGoalStatus(rawStatus, pct)`** ([[../specs/director-proposed-goals]] Phase 1) — the goal's **explicit lifecycle state**, parsed from a `**Status:**` line. `proposed` = a director authored it and it AWAITS the CEO's greenlight (inert: the escort skips it, Pia doesn't decompose it); `greenlit` = CEO-approved/active; `complete` = 100%. An **explicit marker wins**; a legacy goal with no `**Status:**` line is `complete` at 100% else `greenlit` — so a `proposed` 0% goal is now unambiguously distinct from an active 0% one (replacing the old `pct > 0`-infers-greenlit hack the escort used). `proposedBy` is the proposing function from a `**Proposed-by:** [[../functions/x]]` marker (present only on a director-proposed artifact). See [[goal-proposals]].
- **`getRoadmapFilters()`** → `{ goals, goalsBySpec, sourceBySpec }` for the board's goal + source filters ([[../specs/roadmap-goal-and-source-filters]]). **Goal membership** = the union of each goal doc's `[[spec]]` wikilinks (the reliable planner signal) and any spec whose `**Parent:**` references the goal (its slug, title, or a milestone of it). **`SpecSource`** = `repair` (the spec has a `**Repair-signature:**` line — `parseSpec` derives `SpecCard.repairSignature`), else `goal` (wikilinked from a goal doc — wikilink only, not parent-match), else `manual`. No schema change — all derived from the existing markdown.
- **`getArchive()`/`listArchivedSlugs()`** — verified/folded specs from `archive.d/` (← `archive.md` fallback).
- **`extractSpecSection`/`stripSpecSection`** — lift/strip a `## Heading` (the `## Verification` card, [[../specs/verification-guides]]).
- **`phaseEmoji(Phase)`** — the inverse of the internal `statusFromText`; `⏳/🚧/✅/❌`. Used by the blocker chip + the gate error.

## Live status — the DB mirror, not request-time git ([[spec-card-state]])

The board reads the **bundled `fs` copy** here (the markdown baked into the deploy). The deploy-lag that creates — a phase emoji flipping on `main` (a build merges, the spec-drift agent stamps ✅, a fold lands) not reaching the board until the next redeploy — is closed by the [[../tables/spec_card_state]] DB mirror ([[spec-card-state]]), **not** by reading `main` per request. (That request-time git-read approach — `roadmap-reads-specs-from-git` — was tried and **retired**: per-request SHA polling re-fetched the whole brain tree on every push and burned the GitHub core quota → 403s across the box + dashboard.)

- **The mirror is written instantly** on every status event: a build merge ([[agent-jobs]] `reconcileMergedJobs` → `markSpecCardMergeShipped`), a drift flip ([[spec-drift]] `reconcileSpecDrift`), an owner status flip / one-tap drift flip (`/api/roadmap/status`, `/api/roadmap/spec-drift`). Each writes `spec_card_state` the moment it happens — no deploy wait, no GitHub call.
- **The board reads DB-first with markdown fallback.** [[../dashboard/roadmap]] reads `getSpecCardStates(workspaceId)` and overlays it via `resolveBoardStatus(markdown, state)` — whichever of the two is **further along** (DB-first for the deploy-lag; a markdown that's already ahead, a redeploy / owner edit, wins, so markdown stays canonical). A spec with no row falls back to the markdown-parsed status (graceful).
- **`deploy_pending` (shipped · deploying → live).** A merge stamps `last_merge_sha`; the board compares it to the deployed app's own `VERCEL_GIT_COMMIT_SHA` (`deploymentState`) to show **`shipped · deploying`** until a deployment carrying that SHA is live, then **`shipped · live`** — a clean signal, no webhook.
- `parseSpec` is unchanged — only the *live status overlay* moved (from a never-shipped git read to the DB mirror). The goals/functions loaders read `fs` directly (they lag less; no mirror).

## Spec metadata lines (parsed in `parseSpec`)

Under a spec's H1, one-per-concept bold metadata lines, each resolving `[[wikilinks]]` to slugs:

- `**Owner:** [[../functions/{slug}]]` → `owner` (the DRI function).
- `**Parent:** {mandate or goal milestone}` → `parent`.
- `**Repair-signature:** \`…\`` → `repairSignature` (boolean; box-Repair-Agent-authored specs only). Drives the board's "🔧 Repair" source chip via [[#Key exports|getRoadmapFilters]].
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

- **This parser has no DB** — it reads only the bundled markdown on disk (a few hundred small files, cheap). The *live status overlay* lives in a separate DB table ([[spec-card-state]] → [[../tables/spec_card_state]]); the board composes the two. The goals/functions loaders read the bundled disk copy each call.
- **`blockedBy` needs the full set** — `parseSpec` alone can't know another spec's status, so a card's `blockedBy` is only meaningful *after* `getRoadmap`/`getSpec` resolution. A raw `parseSpec(...)` (e.g. inside `deriveSpecStatus`) leaves it unresolved (all `cleared:false`); don't read `blockedBy` off that path.
- **Vercel tracing** — any route that calls these must trace `docs/brain/**` in `next.config.ts` or it reads an empty dir in prod (e.g. `/api/roadmap/build` was added for the spec-blockers gate).

## Related

[[roadmap-actions]] · [[spec-card-state]] · [[../tables/spec_card_state]] · [[../dashboard/roadmap]] · [[../project-management]] · [[../specs/spec-blockers]] · [[../specs/goal-decomposition-engine]] · [[../lifecycles/roadmap-build-console]]

---

[[../README]] · [[../../CLAUDE]]
