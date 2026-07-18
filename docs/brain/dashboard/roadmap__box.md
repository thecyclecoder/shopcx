# Dashboard · roadmap/box

_TODO: page purpose._

**Route:** `/dashboard/roadmap/box`

## Features

**Page title:** Build box

**Rendering:** `"use client"` component (client-side state + fetch).

### Lane grid — per-lane-group view

The box worker runs each `agent_jobs.kind` in its OWN dedicated lane with its own cap (`MAX_CONCURRENT` for the build/plan pool, `MAX_TICKET_HANDLE + MAX_TICKET_ANALYZE + MAX_CS_DIRECTOR_CALL` for customer service, `MAX_PLATFORM_DIRECTOR + MAX_DIRECTOR_COACH` for director, `MAX_FOLD` for fold, everything else in a bag of small concurrency-1/2 lanes). The page renders those groups as SEPARATE `LaneRowGrid` sections — Build/plan · Customer service · Director · Fold · **Producer agents · Supervisory agents** — driven from the heartbeat's `lane_groups` map ([[../tables/worker_heartbeats]] `lane_groups`), so each grid shows in-use/cap for its OWN kinds against the group's OWN cap. Before this the page did `buildLanes = worker.lanes.filter(kind !== 'fold')` and rendered every non-fold kind against `worker.build_lanes`, so a build pool at 10 with a customer-service lane + a director lane active could show "13/10 in use" — nonsense. The caps are now in `lane_groups` (a single source of truth on the heartbeat row) and the render is split into per-group grids.

**⭐ Pool cap vs active-count semantics (`build-box-page-other-lanes-truthful-capacity-not-summed-caps` corrects the prior art `build-box-page-reflects-real-per-lane-group-usage`, which introduced the sum-of-per-kind-MAX display).** Each named lane pool's cap is a REAL concurrent ceiling — **build/plan (10), customer_service (5), director (2), fold (1)** — those are the number of that group's kinds that can actually run at the same time on the box, so `N/CAP in use` is truthful and the grid renders `CAP − N` phantom-free "open" cells to show real headroom. The heartbeat's `other` group is DIFFERENT: it's a set of independently-capped autonomous agents, each MAX_* is 1-2, and they never co-run at their SUMMED ceiling. Rendering it as `active / SUM(all per-kind MAX_*)` presented "4/35 in use" — a phantom ~35-lane pool that made a light box look wildly over-provisioned. The page therefore shows each `other`-derived section **by active count only** (`N active`, no `/CAP` denominator, no phantom open cells; empty-state chip "No … agents running"). Per-kind caps stay enforced in the worker (a spec-test lane at MAX_SPEC_TEST=3 still queues the 4th); this is purely how the page REPRESENTS the bucket. The pure derivation lives in `deriveLaneGroupSections` (`src/lib/box-lane-group-sections.ts`) and the LaneRowGrid component; the invariant is covered by the `src/lib/box-lane-group-sections.test.ts` suite (asserts the derived cap for the two `other`-derived sections is NOT the arithmetic sum of the per-kind caps).

**⭐ Producer vs Supervisory split (`box-page-split-producer-vs-supervisory-lane-groups` — CEO flag: a producer must not read as a supervisor).** The heartbeat still emits ONE `other` bucket, but the display derivation fans it into TWO truthful sections at read time so a domain producer like Dahlia (ad-creative-copy-author, who BUILDS ad creatives) is not shelved under "Supervisory agents". A **PRODUCER_KINDS** set exported from `box-lane-group-sections.ts` names the seven artifact-creator kinds — `product-seed`, `dr-content`, `media-buyer`, `ad-creative`, `ad-creative-copy-author`, `ad-creative-copy-qc`, `storefront-optimizer`. Every kind in the heartbeat's `other.kinds` list that IS in PRODUCER_KINDS lands in the **Producer agents** section; everything else (spec-test, agent-grade, agent-coach, deploy-review, security-review, migration-fix, director-grade, campaign-grade, gap-grade, repair, regression, research, mario, playbook-compile, prompt-review, dev-ask, god-mode, pr-resolve, media-buyer-grade, db_health, coverage-register, proposed-goal, proposed-model-tier, audit-spec-shipped-state, ceo-authorized-out-of-leash, triage-escalations, ticket-improve, spec-chat, …) falls to the **Supervisory agents** section by default — so a newly-added `other` kind can never silently vanish from the display, and it defaults to supervisory until explicitly added to PRODUCER_KINDS. Both sections carry `cap: null` (active-count-only, no phantom denominator). Owner functions in `node-registry`, kill switches, per-kind caps, and worker LANE_GROUPS are UNCHANGED — this is display-only.

The kind-sets mirror the poll-loop `count*` helpers in `scripts/builder-worker.ts`:

| Group | Display cap | Kind of ceiling | Kinds |
|---|---|---|---|
| `build_plan` | `MAX_CONCURRENT` | REAL concurrent pool — `N/CAP in use` | `build`, `plan` |
| `customer_service` | `MAX_TICKET_HANDLE + MAX_TICKET_ANALYZE + MAX_CS_DIRECTOR_CALL` | REAL concurrent pool — `N/CAP in use` | `ticket-handle` (Sol), `ticket-analyze` (Cora), `cs-director-call` (June) |
| `director` | `MAX_PLATFORM_DIRECTOR + MAX_DIRECTOR_COACH` | REAL concurrent pool — `N/CAP in use` | `platform-director`, `director-bounce-back`, `growth-director`, `director-coach` |
| `fold` | `MAX_FOLD` | REAL concurrent pool — `N/CAP in use` | `fold`, `goal-fold` |
| `producer` (rendered as **"Producer agents"** — derived from heartbeat's `other`) | — (no denominator) | ARTIFACT-CREATOR BUCKET — shown as **`N active`**, never a summed lane pool | `PRODUCER_KINDS` (`product-seed`, `dr-content`, `media-buyer`, `ad-creative`, `ad-creative-copy-author`, `ad-creative-copy-qc`, `storefront-optimizer`) |
| `supervisory` (rendered as **"Supervisory agents"** — derived from heartbeat's `other`) | — (no denominator) | SUPERVISORY BUCKET — independently-capped autonomous agents, shown as **`N active`**, never a summed lane pool | everything else in `other.kinds` (`spec-chat`, `spec-test`, `migration-fix`, `deploy-review`, `mario`, `playbook-compile`, `prompt-review`, `dev-ask`, `god-mode`, `pr-resolve`, `repair`, `regression`, `security-review`, `agent-grade`, `agent-coach`, `director-grade`, `campaign-grade`, `gap-grade`, `research`, `media-buyer-grade`, `db_health`, `coverage-register`, `proposed-goal`, `proposed-model-tier`, `audit-spec-shipped-state`, `ceo-authorized-out-of-leash`, `triage-escalations`, `ticket-improve`, …) |

An unknown group key falls back to its raw key so a new group added on the box shows up on the page without a page-side update. A legacy heartbeat row written before `lane_groups` existed (null) falls back to the pre-existing single-pool render (Build/plan lanes + Fold lane) — nothing regresses on an older box.

The `BoxChip` on the roadmap header shows the BUILD/PLAN pool only (`lane_groups.build_plan.cap`) — before this it counted every non-fold kind against `build_lanes`, so the chip could also overflow.

**⭐ Dual-persona session cards (`box-page-shows-both-avatars-for-ping-pong-ad-creative-sessions`).** A session that has TWO collaborators under ONE parent job renders BOTH personas' avatars side-by-side (overlapping via `-space-x-2`) + a dual title + a static sub-task label chip, so the collaboration is visible at a glance and the card doesn't read as one long single-agent session. Two flavors: (1) a fused pre-merge spec-test lane (`kind='spec-test' && fused_pre_merge=true`) — Vera + Vault emit both verdicts off the SAME loaded diff in ONE session (`fusedPreMergeInfo`); (2) an ad-creative-copy-author ping-pong (`kind='ad-creative-copy-author'`) — Dahlia (ad-creative) authors a creative and Max (ad-creative-copy-qc / growth grader) independently grades it, bouncing back and forth across the revise loop under ONE parent job (`pingPongInfo`). The `LaneCell` (in-flight) + `QueuedJobsLog` (queued) both compose `dual = fusedPreMergeInfo(...) ?? pingPongInfo(...)`; every other kind falls back to the single-avatar path via `personaForKind(kind)`. Pure display — no change to job/lane logic.

**⭐ Active-persona swap for the ping-pong (Phase 2 of the same spec).** On an in-flight `ad-creative-copy-author` LaneCell, the dual (both-avatar) render is replaced by a SINGLE currently-active avatar whenever Phase 1's checklist unambiguously names who is working right now — Dahlia while she authors/revises, Max while he grades. The `activePingPongPersona(kind, session_checklist)` helper reads the `in_progress` checklist item and matches its step/note text against strong Max tokens first (`max`/`grade`/`grading`/`copy-qc`/`qc`/`score`) then Dahlia tokens (`dahlia`/`author`/`authoring`/`revise`/`revising`); a null (idle, no checklist yet, ambiguous step) falls back to the dual render. The dual title ("Dahlia → Max · ad-creative ping-pong") + dual label chip ("author · copy-QC") stay in place under the swapped avatar so the ping-pong composition is still visible in text while the photo reflects the current actor. `QueuedJobsLog` (queued jobs, not active) keeps the dual render unchanged. Pure display — the swap is driven off the same `session_checklist` field the shared box-session runner already writes.

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
- `src/lib/box-lane-group-sections.ts` — pure `deriveLaneGroupSections` display helper (real-pool cap vs supervisory-bucket cap=null semantics + `PRODUCER_KINDS` split — the heartbeat's `other` bucket fans into `producer` + `supervisory` sections)
- `src/lib/box-lane-group-sections.test.ts` — asserts the two `other`-derived sections carry `cap:null` and that ad-creative-copy-author (Dahlia) lands in `producer`, not `supervisory`
- `docs/brain/tables/worker_heartbeats.md` — the underlying table page (`lane_groups` column)

---

[[../README]] · [[../../CLAUDE]]
