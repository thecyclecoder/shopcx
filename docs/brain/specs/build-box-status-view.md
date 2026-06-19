# Build-box status view — live lanes on the roadmap ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The worker now writes a heartbeat ([[worker-self-update]] → `worker_heartbeats`: `running_sha`, `status`, `active_builds`, `last_poll_at`). Surface it on the roadmap as a **live build-box view**: how many lanes exist, how many are in use, and **what each lane is building right now** — so "is the box healthy / busy / behind?" is answerable from the dashboard (phone-friendly) instead of SSH. No new infra: the data is `worker_heartbeats` + the live `agent_jobs` rows; we just enrich + render it.

## Phase 1 — Enrich the heartbeat with lane detail ✅
- ✅ `scripts/builder-worker.ts`: each poll tick, write the full lane picture to `worker_heartbeats` — add `build_lanes int` (= `MAX_CONCURRENT`), `fold_lanes int` (= `MAX_FOLD`), and `lanes jsonb` = `[{ kind, job_id, spec_slug, since }]` for every in-flight lane (from the worker's `active` map + each job's slug). Keep `status`/`running_sha`/`active_builds`/`last_poll_at`.
- ✅ Migration: `alter table worker_heartbeats add column if not exists build_lanes int, fold_lanes int, lanes jsonb default '[]'`. Idempotent; apply via [[../recipes/write-a-migration-apply-script|write-migration]]. Brain page [[../tables/worker_heartbeats]] updated same PR.

## Phase 2 — `/dashboard/roadmap/box` subpage ✅
- ✅ New route `src/app/dashboard/roadmap/box/page.tsx` (owner-only, server + client poll every ~5s). Reads the singleton `worker_heartbeats` row + open `agent_jobs` (queued/building/needs_*).
- ✅ **Health header:** `healthy / stale` (stale if `last_poll_at` > ~30s old), `running_sha` (link to the commit), uptime since `started_at`.
- ✅ **Lane grid:** `build_lanes` + `fold_lanes` as cells; each in-use cell shows its `spec_slug`, `kind` chip, and elapsed (`now − since`); free cells show "open". A queue-depth count below (jobs waiting). A `needs_input`/`needs_approval` callout if any job is paused.
- ✅ Reuse [[../dashboard/roadmap]] card styling; link spec_slugs to `/dashboard/roadmap/[slug]`.

## Phase 3 — Surfacing ✅
- ✅ Sidebar: **Build box** under Developer (next to Roadmap / Goals / Map).
- ✅ A compact chip on the roadmap board header: "Build box · 3/5 lanes · healthy" → links to the box view. Stale/red if the heartbeat is old.

## Safety / invariants
- Read-only visualization; no control actions (pausing/killing lanes is out of scope — [[../recipes/manage-the-build-queue]] is the CLI for that).
- Heartbeat write must stay cheap (one upsert/tick) and never block the poll loop.
- Worker change → **infra build, serialize**; deploys itself once merged ([[worker-self-update]]).

## Completion criteria
- `/dashboard/roadmap/box` shows, live: box health + SHA, N/5 build lanes + N/1 fold lane in use, and the spec each busy lane is building, plus queue depth.
- The board header chip reflects lane usage + health and goes stale/red if the box stops heartbeating.

## Verification
- On `/dashboard/roadmap/box` → expect a **health header** (healthy/stale, `running_sha` linking to the commit, uptime), a **lane grid** of N build lanes + 1 fold lane, and a queue-depth count.
- Queue a build (Build on any spec) → within ~5s expect one build lane to fill with that **spec_slug**, a `build` kind chip, and a **live elapsed** timer counting up.
- On the `/dashboard/roadmap` board header → expect the **"Build box · N/5 lanes · healthy"** chip linking to the box view.
- Stop the worker (or wait for a heartbeat gap) → within ~30s expect the header chip + box health to go **stale/red** (`last_poll_at` aged out).

## Related
[[worker-self-update]] · [[parallel-builds]] · [[fold-build-batching]] · [[roadmap-build-console]] · [[../dashboard/roadmap]] · [[../tables/agent_jobs]] · [[../recipes/build-box-setup]]
