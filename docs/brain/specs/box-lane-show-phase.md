# Build box lane shows which phase it's building ⏳

**Owner:** [[../functions/platform]] · **Parent:** small observability add to the build-console box view (`/dashboard/roadmap/box`). · **Requested 2026-06-22:** with "Build all" chaining phases, a lane shows only the spec slug (`storefront-ltv-proxy-reconciler`) — the owner can't tell *which phase* is building. Show it (`storefront-ltv-proxy-reconciler · Phase 2`).

The box lane picture comes from `worker_heartbeats.lanes` (`LaneRow = { kind, job_id, spec_slug, since }`), written by the worker (`scripts/builder-worker.ts` `writeHeartbeat`). The worker holds each active job, whose phase is derivable: a phase/chained build's `instructions` embed the phase (the `phaseScopedInstructions` format — `… "Phase N — <title>"`), so parse it; a whole-spec build has no single phase.

## Fix
- **Worker:** when building the `lanes` array for the heartbeat, add an optional `phase` to each `LaneRow` — derived from the job (parse `Phase N` / the phase title from its `instructions`, or a stored phase field if one exists). Null for non-phase builds.
- **Box API** (`/api/roadmap/box`): thread `phase` through `LaneRow` (already passes the row shape).
- **Box page** (`box/page.tsx`): render it next to the slug — `spec-slug · Phase N` (or just the slug when no phase). Keep it compact (the lane card is small).

## Verification
- A lane running a chained/phase build shows `slug · Phase N` (e.g. `storefront-ltv-proxy-reconciler · Phase 2`); a whole-spec (non-phase) build shows just the slug.
- The phase reflects the actual phase the build is on (matches the job's instructions); when the build advances to the next chained phase, the lane updates on the next heartbeat.
- Negative: a non-build lane (spec-test/fold/plan) is unaffected; a build with unparseable instructions falls back to the slug only (no crash).

## Phase 1 — phase on the lane (worker → API → page) ⏳
Add `phase` to `LaneRow`, derive it in the worker's heartbeat lane-build, pass it through `/api/roadmap/box`, render `slug · Phase N` in `box/page.tsx`. Brain: [[../dashboard/roadmap]] · [[build-all-phases-chain]].
