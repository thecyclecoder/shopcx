# dashboard/roadmap

The project-manager board + build console for the brain. Reads `docs/brain/specs/` to show **planned / in progress / shipped**, and (owner-only) lets you edit status, author/refine specs with Opus, dispatch autonomous builds on the box, answer build questions, approve prod actions, and squash-merge — all phone-friendly. Full end-to-end: [[../lifecycles/roadmap-build-console]].

**Routes:** `/dashboard/roadmap` (board) + `/dashboard/roadmap/[slug]` (spec detail) + `/dashboard/roadmap/map` (taxonomy: Function → Mandate/Goal → Spec) + `/dashboard/roadmap/goals` + `/dashboard/roadmap/goals/[slug]` (goal board + detail) + `/dashboard/roadmap/functions/[slug]` (function home). Server components, `dynamic = "force-dynamic"`.
**Sidebar:** **Developer** section (owner-only) → **Roadmap** + [[branches]].

## Surfaces

- **Board** — `src/lib/brain-roadmap.ts` `getRoadmap()` parses specs (+ `README.md` track chips). Three columns from each spec's status (`⏳ planned · 🚧 in progress · ✅ shipped`; phases can also be `❌ cut`). Cards show summary, phase count pills, and live build status.
- **Detail page** — `marked` → `prose`; `[[wikilinks]]` to other specs become links. **Refine with Opus** button.
- **Editable status** (owner) — `StatusControl.tsx` (card: Planned/Doing/Shipped) and `PhaseList.tsx` (per-phase dots incl. **Cut**, + a per-phase **build**). Each click commits the emoji to the brain markdown on `main` via `POST /api/roadmap/status` (`phaseIndex` targets the Nth `## Phase`). The markdown stays the source of truth — no DB overrides.
- **Authoring chat** — `AuthoringChat.tsx` + `POST /api/roadmap/chat` (Opus `claude-opus-4-8`, Anthropic API). **✨ New feature** (board header) writes a new `specs/{slug}.md`; **Refine with Opus** (detail page) edits an existing one. Finalize commits the spec to `main` (+ optional **Save & build** queues a job).
- **Build dispatch** — `BuildButton.tsx`: **Build/Rebuild** (hidden on shipped specs), per-phase **build**, and **Report issue** (queues a scoped *fix-build* via `instructions` — works on shipped specs, no spec edit). All hit `POST /api/roadmap/build` → inserts an [[../tables/agent_jobs]] row (one active per spec). The chip polls `GET /api/roadmap/build?slug=` until terminal.
- **Build feedback** — when a build pauses: `needs_input` shows an **answer form** (`POST /api/roadmap/answer`); `needs_approval` shows **Approve & apply** cards with the command preview (`POST /api/roadmap/approve`). Both flip the job to `queued_resume` so the box worker resumes it. Completed builds show **Squash & merge** (reuses `POST /api/branches/[number]/merge`).
- **Verify + archive** (`BuildButton.tsx`, owner) — shipped cards show **Mark verified & archive**: the owner-only, human "I tested it in prod" gate distinct from Shipped (built + deployed, automated). It queues a **fold-build** (`POST /api/roadmap/build` `{ verify: true }` → canonical fold instructions): the build folds the spec into its brain homes, appends an entry to [[../archive]], `git rm`s `specs/{slug}.md`, and opens a PR. Merge → the spec leaves the board into the **Archived** section. The Shipped column is relabeled **"Shipped — awaiting verification"** so it stays a short, real to-do list.
- **Archived section** — a collapsed `<details>` below the columns reads [[../archive]] (`getArchive()` parses its index list) and lists verified features (link → their lifecycle/brain page). Each row also offers **New spec from brain** (re-hydration) seeded with that page.
- **New spec from brain** (re-hydration) — `AuthoringChat seed` (board header **🧠 New spec from brain**, or per archived entry with a fixed `seedSlug`). Pick a brain page (lifecycle/dashboard/table) or archived entry → `POST /api/roadmap/chat` seeds Opus with the **current** brain page content → drafts a *fresh* spec to extend/fix it (never reactivates a stale snapshot) → normal Save / Save & build.
- **Taxonomy map** (`/map`, `getFunctionMap()`) — every spec grouped Function → Mandate/Goal → Spec, built from each spec's owner + parent (so it never drifts). Function headers link to the function home; an **Orphan specs** panel flags any spec with no owner (the no-orphan lint).
- **Goals board + detail** (`/goals`, `/goals/[slug]`, `getGoals()`/`getGoal()`) — the [[../specs/goal-decomposition-engine|goal-decomposition engine]] surface. Cards show success metric, a **rollup % bar** (mean of milestone completion — `parseGoal` averages each milestone's linked-spec phase completion; advances automatically as leaf specs ship), and milestone/spec counts. Detail renders the goal doc + a **milestone tree** with each leaf spec's live status, and an owner-only **Plan / Re-plan** control (`PlanButton.tsx`).
- **Function home** (`/functions/[slug]`, `getFunction()`/`parseFunction()`) — the director's charter rendered + a sidebar of mandates (each perpetual: metric + owned specs, **no %**) and owned/contributed goals. A spec card's owner chip links here.
- **Plan a goal** (`PlanButton.tsx`, owner) — **Plan goal** / **Re-plan** → `POST /api/roadmap/plan` inserts a `kind='plan'` [[../tables/agent_jobs]] row (one active plan per goal). The box worker runs the `plan-goal` skill → proposes a milestone→spec tree as `pending_actions` (`type:'spec'`) → `needs_approval`. The button shows each proposed branch (owner · parent · intent) with **Approve / Decline** (reuses `POST /api/roadmap/approve`); once every branch is decided the job → `queued_resume` and the worker auto-authors the approved specs (committed to main), wikilinks them into the goal doc, records declines (❌), and queues their builds. Polls `GET /api/roadmap/plan?goalSlug=`.

## Data sources

- **Brain markdown** (board + detail) — `docs/brain/specs/*.md` + `docs/brain/goals/*.md` + `docs/brain/functions/*.md`, read at request time via `src/lib/brain-roadmap.ts` (`getRoadmap`/`getSpec`/`getGoals`/`getGoal`/`getFunctions`/`getFunction`/`getFunctionMap`; `parseGoal`/`parseFunction` extract milestones/mandates + linked specs + rollup). `[[wikilinks]]` resolve to dashboard routes via `src/lib/brain-links.ts` (`preprocessBrainWikilinks` — specs→`/roadmap/{slug}`, goals→`/roadmap/goals/{slug}`, functions→`/roadmap/functions/{slug}`). The static, canonical layer.
- **`agent_jobs`** (live build + plan state) — read via `getLatestJobsBySlug(workspaceId)` (build cards) + `getLatestPlanJob(workspaceId, goalSlug)` (goal Plan control); `BuildButton`/`PlanButton` poll the API for updates. The live, actionable layer.

## Billing

Authoring chat → Anthropic API (cheap). Builds → **Max** (box `claude -p`, no API key). See [[../lifecycles/roadmap-build-console]] § Billing.

## Vercel gotcha

The board/detail read files under `docs/brain/`, which Vercel's tracer would prune. `next.config.ts` → `outputFileTracingIncludes` ships the spec/lifecycle/**goals/functions** markdown into the `/dashboard/roadmap`, `/[slug]`, `/map`, `/goals`, `/goals/[slug]`, and `/functions/[slug]` function bundles. Without it those routes render empty in prod. (The chat/build/status/approve/**plan** API routes read the brain from **GitHub** at request time, so they don't need tracing.)

## Status / open work

**Shipped:** board, detail pages, editable card + per-phase status (incl. Cut), authoring chat (new + refine + **seed/re-hydrate**), build dispatch + per-phase build + report-issue fix-builds, answer loop, approval gates, squash-merge, **verify → fold-build → archive** (Mark verified & archive), the **Archived** section, **New spec from brain**, the **taxonomy map**, and the **goals + functions layer** (goal board/detail with rollup, function homes, **Plan/Re-plan** → planner → approve tree → auto-author + queue builds — the [[../specs/goal-decomposition-engine|goal-decomposition engine]]). The box worker runs builds + plans on Max ([[../recipes/build-box-setup]]).

**Open:** instant card re-bucket on status change (currently reflects on reload); README track-emoji auto-sync; the `needs_input`/`needs_approval` round-trips + the **plan→approve→author** loop await their first real-run exercise; the **New spec from brain** picker is a typed brain-slug (no autocomplete over the ~600 pages yet). The planner commits authored specs **straight to main** (no separate planning PR) so queued builds find them on `origin/main`; the build PRs remain the code merge-gate.

## Related

[[../lifecycles/roadmap-build-console]] · [[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../specs/goal-decomposition-engine]] · [[../archive]] · [[../tables/agent_jobs]] · [[branches]] · [[../recipes/build-box-setup]] · [[../project-management]] · [[../functions/platform]] · [[../goals/ceo-mode]]
