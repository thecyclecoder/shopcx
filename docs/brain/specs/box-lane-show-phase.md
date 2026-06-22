# Build box lane shows which phase it's building ✅

**Owner:** [[../functions/platform]] · **Parent:** small observability add to the build-console box view (`/dashboard/roadmap/box`). · **Requested 2026-06-22:** with "Build all" chaining phases, a lane shows only the spec slug (`storefront-ltv-proxy-reconciler`) — the owner can't tell *which phase* is building. Show it (`storefront-ltv-proxy-reconciler · Phase 2`).

The box lane picture comes from `worker_heartbeats.lanes` (`LaneRow = { kind, job_id, spec_slug, since }`), written by the worker (`scripts/builder-worker.ts` `writeHeartbeat`). The worker holds each active job, whose phase is derivable: a phase/chained build's `instructions` embed the phase (the `phaseScopedInstructions` format — `… "Phase N — <title>"`), so parse it; a whole-spec build has no single phase.

## Fix
- **Worker:** when building the `lanes` array for the heartbeat, add an optional `phase` to each `LaneRow` — derived from the job (parse `Phase N` / the phase title from its `instructions`, or a stored phase field if one exists). Null for non-phase builds.
- **Box API** (`/api/roadmap/box`): thread `phase` through `LaneRow` (already passes the row shape).
- **Box page** (`box/page.tsx`): render it next to the slug — `spec-slug · Phase N` (or just the slug when no phase). Keep it compact (the lane card is small).

## Verification
- On `/dashboard/roadmap/box`, with a per-phase or chained build in a Build/plan lane → expect the lane card to read `slug · Phase N` (e.g. `storefront-ltv-proxy-reconciler · Phase 2`), the `· Phase N` muted after the slug. A whole-spec "Build all the spec" lane → expect just the slug, no `· Phase`.
- On `GET /api/roadmap/box`, inspect `worker.lanes[]` while a phased build runs → expect each lane object to carry `phase: "Phase N"` matching the job's instructions; advance the chain to the next phase and re-poll (~5s) → expect the lane's `phase` to update on the next heartbeat tick.
- Negative — on `/dashboard/roadmap/box`, a fold/spec-test/plan lane → expect no `· Phase` suffix (its instructions carry no `Phase N`); a build whose instructions don't embed `Phase N` → expect the card falls back to slug-only with no crash (`derivePhase` returns null).

## Phase 1 — phase on the lane (worker → API → page) ✅
Add `phase` to `LaneRow`, derive it in the worker's heartbeat lane-build, pass it through `/api/roadmap/box`, render `slug · Phase N` in `box/page.tsx`. Brain: [[../dashboard/roadmap]] · [[build-all-phases-chain]].

Shipped: `scripts/builder-worker.ts` — `derivePhase(instructions)` regexes `Phase N` out of the job's instructions (the `phaseScopedInstructions` format embeds `"Phase N — <title>"`); `LaneInfo`/`LaneRow` carry `phase`, set at `launch()` from `job.instructions`, written on every heartbeat tick. `/api/roadmap/box` `LaneRow` declares `phase?` (the `lanes` array passes through as-is). `box/page.tsx` `LaneCell` renders ` · Phase N` (muted) after the slug when present, slug-only otherwise.
