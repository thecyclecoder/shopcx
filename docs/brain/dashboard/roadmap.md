# dashboard/roadmap

Project-manager board that reads the brain and shows what's **planned / in progress / shipped** — the read-only Phase 1 of [[../specs/roadmap-build-console]]. Owner-only (under the **Developer** sidebar section, alongside [[branches]]).

**Routes:** `/dashboard/roadmap` (board) + `/dashboard/roadmap/[slug]` (spec detail) — both server components, `dynamic = "force-dynamic"`.
**Parser:** `src/lib/brain-roadmap.ts` → `getRoadmap()` (board), `getSpec(slug)` + `listSpecSlugs()` (detail).
**Detail render:** `marked` → `prose` (`@tailwindcss/typography`); `[[wikilinks]]` to specs become links to their detail pages, other brain links render as plain text.
**Status editing:** `StatusControl.tsx` (owner-only client control) → `POST /api/roadmap/status` rewrites the H1 emoji in `specs/{slug}.md` and **commits straight to main** via the GitHub Contents API (owner-gated, mirrors [[branches]]). The brain markdown stays the source of truth — no DB overrides. Optimistic UI; each save is a commit → a Vercel deploy.
**Sidebar:** **Developer** section (owner-only) → **Roadmap** + **Branches**.

## Data source — the markdown is the spec

No DB. `getRoadmap()` reads `docs/brain/specs/*.md` (+ `specs/README.md` for project tracks, + `lifecycles/*.md` reserved for shipped status) at request time and derives status from the `⏳ planned · 🚧 in progress · ✅ shipped` phase emojis. Editing a spec — or a build flipping a phase emoji — updates the board with zero drift.

Per spec card: `title` (H1, emoji stripped), overall `status` (from the H1 emoji, else derived from phases), `summary` (first plain paragraph), and `phases[]` (each `## Phase …` heading + its status, read from the heading emoji or the first bullet under it). `specs/README.md` `## Active project …` headings become the project-track chips.

## Render

Three columns (Planned / In progress / Shipped) grouped from the spec cards; each card has a status dot, summary, count pills, and a native `<details>` phase breakdown. A track-chip strip (from `README.md`) sits above the columns.

## Vercel gotcha

The route reads files under `docs/brain/`, which Vercel's file tracer would otherwise prune (nothing imports them). `next.config.ts` → `outputFileTracingIncludes["/dashboard/roadmap"]` ships the markdown into the function bundle. Without it the board renders empty in production.

## Status / open work

**Shipped:** Phase 1 board (parser + columns + track chips + nav); clickable spec **detail pages** (`marked` → `prose`, wikilinks→links); owner **status editing** (segmented control → emoji commit to main).

**Not yet (later phases of [[../specs/roadmap-build-console]]):** spec-authoring chat (Opus), the `agent_jobs` queue + "Build" button, the box `systemd` worker that runs the build on Max, and the per-card live build status + questions loop. Possible polish: skip the Vercel deploy for status-only commits + read status live (the "no churn" option we deferred); auto-sync the README track emoji when a spec's status flips.

## Related

[[../specs/roadmap-build-console]] · [[../specs/repo-skills-catalog]] · [[branches]] · [[../project-management]] · [[../lifecycles/agent-todo-system]]
