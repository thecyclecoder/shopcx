# Dashboard · roadmap/box

_TODO: page purpose._

**Route:** `/dashboard/roadmap/box`

## Features

**Page title:** Build box

**Rendering:** `"use client"` component (client-side state + fetch).

### Lane grid — per-lane-group view

The box worker runs each `agent_jobs.kind` in its OWN dedicated lane with its own cap (`MAX_CONCURRENT` for the build/plan pool, `MAX_TICKET_HANDLE + MAX_TICKET_ANALYZE + MAX_CS_DIRECTOR_CALL` for customer service, `MAX_PLATFORM_DIRECTOR + MAX_DIRECTOR_COACH` for director, `MAX_FOLD` for fold, everything else in a bag of small concurrency-1/2 lanes). The page renders those groups as SEPARATE `LaneRowGrid` sections — Build/plan · Customer service · Director · Fold · Supervisory agents — driven from the heartbeat's `lane_groups` map ([[../tables/worker_heartbeats]] `lane_groups`), so each grid shows in-use/cap for its OWN kinds against the group's OWN cap. Before this the page did `buildLanes = worker.lanes.filter(kind !== 'fold')` and rendered every non-fold kind against `worker.build_lanes`, so a build pool at 10 with a customer-service lane + a director lane active could show "13/10 in use" — nonsense. The caps are now in `lane_groups` (a single source of truth on the heartbeat row) and the render is split into per-group grids.

**⭐ Pool cap vs supervisory-bucket semantics (`build-box-page-other-lanes-truthful-capacity-not-summed-caps` corrects the prior art `build-box-page-reflects-real-per-lane-group-usage`, which introduced the sum-of-per-kind-MAX display).** Each named lane pool's cap is a REAL concurrent ceiling — **build/plan (10), customer_service (5), director (2), fold (1)** — those are the number of that group's kinds that can actually run at the same time on the box, so `N/CAP in use` is truthful and the grid renders `CAP − N` phantom-free "open" cells to show real headroom. The `other` group is DIFFERENT: it's a set of independently-capped autonomous supervisory agents (spec-test, agent-grade, agent-coach, spec-review, research, dr-content, deploy-review, playbook-compile, …), each MAX_* is 1-2, and they never co-run at their SUMMED ceiling. Rendering it as `active / SUM(all per-kind MAX_*)` presented "4/35 in use" — a phantom ~35-lane pool that made a light box look wildly over-provisioned. The page therefore shows the `other` bucket **by active count only** ("Supervisory agents · N active", no `/CAP` denominator, no phantom open cells; empty-state chip "No supervisory agents running"). Per-kind supervisory caps stay enforced in the worker (a spec-test lane at MAX_SPEC_TEST=3 still queues the 4th); this is purely how the page REPRESENTS the bucket. The pure derivation lives in `deriveLaneGroupSections` (`src/lib/box-lane-group-sections.ts`) and the LaneRowGrid component; the invariant is covered by the `src/lib/box-lane-group-sections.test.ts` suite (asserts the derived cap for `other` is NOT the arithmetic sum of the per-kind caps).

The kind-sets mirror the poll-loop `count*` helpers in `scripts/builder-worker.ts`:

| Group | Display cap | Kind of ceiling | Kinds |
|---|---|---|---|
| `build_plan` | `MAX_CONCURRENT` | REAL concurrent pool — `N/CAP in use` | `build`, `plan` |
| `customer_service` | `MAX_TICKET_HANDLE + MAX_TICKET_ANALYZE + MAX_CS_DIRECTOR_CALL` | REAL concurrent pool — `N/CAP in use` | `ticket-handle` (Sol), `ticket-analyze` (Cora), `cs-director-call` (June) |
| `director` | `MAX_PLATFORM_DIRECTOR + MAX_DIRECTOR_COACH` | REAL concurrent pool — `N/CAP in use` | `platform-director`, `director-bounce-back`, `growth-director`, `director-coach` |
| `fold` | `MAX_FOLD` | REAL concurrent pool — `N/CAP in use` | `fold`, `goal-fold` |
| `other` (rendered as **"Supervisory agents"**) | — (no denominator) | SUPERVISORY BUCKET — independently-capped autonomous agents, shown as **`N active`**, never a summed lane pool | everything else (`product-seed`, `spec-chat`, `spec-test`, `spec-review`, `migration-fix`, `deploy-review`, `playbook-compile`, `prompt-review`, `dev-ask`, `god-mode`, `pr-resolve`, `repair`, `regression`, `security-review`, `agent-grade`, `agent-coach`, `director-grade`, `campaign-grade`, `gap-grade`, `research`, `dr-content`, `media-buyer`, `media-buyer-grade`, `storefront-optimizer`, `db_health`, `coverage-register`, `proposed-goal`, `proposed-model-tier`, `audit-spec-shipped-state`, `ceo-authorized-out-of-leash`, `triage-escalations`, `ticket-improve`) |

An unknown group key falls back to its raw key so a new group added on the box shows up on the page without a page-side update. A legacy heartbeat row written before `lane_groups` existed (null) falls back to the pre-existing single-pool render (Build/plan lanes + Fold lane) — nothing regresses on an older box.

The `BoxChip` on the roadmap header shows the BUILD/PLAN pool only (`lane_groups.build_plan.cap`) — before this it counted every non-fold kind against `build_lanes`, so the chip could also overflow.

## Sub-routes

_None._

## API endpoints called

- `/api/roadmap/box`
- `/api/roadmap/box/dismiss-failed`
- `/api/roadmap/box/drain`
- `/api/roadmap/build`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/roadmap/box/page.tsx` — the page itself
- `src/app/dashboard/roadmap/BoxChip.tsx` — the compact chip on the roadmap header (build/plan pool count)
- `src/app/api/roadmap/box/route.ts` — the API this page + chip poll (passes `worker.lane_groups` through)
- `scripts/builder-worker.ts` — the box worker's `writeHeartbeat` (emits the `lane_groups` map)
- `src/lib/box-lane-group-sections.ts` — pure `deriveLaneGroupSections` display helper (real-pool cap vs supervisory-bucket cap=null semantics; see `src/lib/box-lane-group-sections.ts`)
- `src/lib/box-lane-group-sections.test.ts` — asserts the derived cap for `other` is NOT the arithmetic sum of the per-kind caps
- `docs/brain/tables/worker_heartbeats.md` — the underlying table page (`lane_groups` column)

---

[[../README]] · [[../../CLAUDE]]
