# dashboard/roadmap

The project-manager board + build console for the brain. Reads `docs/brain/specs/` to show **planned / in progress / shipped**, and (owner-only) lets you edit status, author/refine specs with Opus, dispatch autonomous builds on the box, answer build questions, approve prod actions, and squash-merge — all phone-friendly. Full end-to-end: [[../lifecycles/roadmap-build-console]].

**Routes:** `/dashboard/roadmap` (board) + `/dashboard/roadmap/[slug]` (spec detail). Server components, `dynamic = "force-dynamic"`.
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

## Data sources

- **Brain markdown** (board + detail) — `docs/brain/specs/*.md`, read at request time. The static, canonical layer.
- **`agent_jobs`** (live build state) — read via `getLatestJobsBySlug(workspaceId)` (admin client) for initial render; `BuildButton` polls the API for updates. The live, actionable layer.

## Billing

Authoring chat → Anthropic API (cheap). Builds → **Max** (box `claude -p`, no API key). See [[../lifecycles/roadmap-build-console]] § Billing.

## Vercel gotcha

The board/detail read files under `docs/brain/`, which Vercel's tracer would prune. `next.config.ts` → `outputFileTracingIncludes` ships the spec/lifecycle markdown into the `/dashboard/roadmap` + `/dashboard/roadmap/[slug]` function bundles. Without it the board renders empty in prod. (The chat/build/status/approve API routes read the brain from **GitHub** at request time, so they don't need tracing.)

## Status / open work

**Shipped:** board, detail pages, editable card + per-phase status (incl. Cut), authoring chat (new + refine + **seed/re-hydrate**), build dispatch + per-phase build + report-issue fix-builds, answer loop, approval gates, squash-merge, **verify → fold-build → archive** (Mark verified & archive), the **Archived** section, and **New spec from brain**. The box worker runs builds on Max ([[../recipes/build-box-setup]]).

**Open:** instant card re-bucket on status change (currently reflects on reload); README track-emoji auto-sync; the `needs_input`/`needs_approval` round-trips await their first real-build exercise; the **New spec from brain** picker is a typed brain-slug (no autocomplete over the ~600 pages yet).

## Related

[[../lifecycles/roadmap-build-console]] · [[../specs/roadmap-build-console]] · [[../specs/build-approval-gates]] · [[../archive]] · [[../tables/agent_jobs]] · [[branches]] · [[../recipes/build-box-setup]] · [[../project-management]]
