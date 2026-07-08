# Dashboard · roadmap/box

_TODO: page purpose._

**Route:** `/dashboard/roadmap/box`

## Features

**Page title:** Build box

**Rendering:** `"use client"` component (client-side state + fetch).

### Lane grid — per-lane-group view

The box worker runs each `agent_jobs.kind` in its OWN dedicated lane with its own cap (`MAX_CONCURRENT` for the build/plan pool, `MAX_TICKET_HANDLE + MAX_TICKET_ANALYZE + MAX_CS_DIRECTOR_CALL` for customer service, `MAX_PLATFORM_DIRECTOR + MAX_DIRECTOR_COACH` for director, `MAX_FOLD` for fold, everything else in a bag of small concurrency-1/2 lanes). The page renders those groups as SEPARATE `LaneRowGrid` sections — Build/plan · Customer service · Director · Fold · Other — driven from the heartbeat's `lane_groups` map ([[../tables/worker_heartbeats]] `lane_groups`), so each grid shows in-use/cap for its OWN kinds against the group's OWN cap. Before this the page did `buildLanes = worker.lanes.filter(kind !== 'fold')` and rendered every non-fold kind against `worker.build_lanes`, so a build pool at 10 with a customer-service lane + a director lane active could show "13/10 in use" — nonsense. The caps are now in `lane_groups` (a single source of truth on the heartbeat row) and the render is split into per-group grids.

The kind-sets mirror the poll-loop `count*` helpers in `scripts/builder-worker.ts`:

| Group | Cap (from `MAX_*`) | Kinds |
|---|---|---|
| `build_plan` | `MAX_CONCURRENT` | `build`, `plan` |
| `customer_service` | `MAX_TICKET_HANDLE + MAX_TICKET_ANALYZE + MAX_CS_DIRECTOR_CALL` | `ticket-handle` (Sol), `ticket-analyze` (Cora), `cs-director-call` (June) |
| `director` | `MAX_PLATFORM_DIRECTOR + MAX_DIRECTOR_COACH` | `platform-director`, `director-bounce-back`, `growth-director`, `director-coach` |
| `fold` | `MAX_FOLD` | `fold`, `goal-fold` |
| `other` | sum of the remaining `MAX_*` | everything else (`product-seed`, `spec-chat`, `spec-test`, `spec-review`, `migration-fix`, `deploy-review`, `playbook-compile`, `prompt-review`, `dev-ask`, `god-mode`, `pr-resolve`, `repair`, `regression`, `security-review`, `agent-grade`, `agent-coach`, `director-grade`, `campaign-grade`, `gap-grade`, `research`, `dr-content`, `media-buyer`, `media-buyer-grade`, `storefront-optimizer`, `db_health`, `coverage-register`, `proposed-goal`, `proposed-model-tier`, `audit-spec-shipped-state`, `ceo-authorized-out-of-leash`, `triage-escalations`, `ticket-improve`) |

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
- `docs/brain/tables/worker_heartbeats.md` — the underlying table page (`lane_groups` column)

---

[[../README]] · [[../../CLAUDE]]
