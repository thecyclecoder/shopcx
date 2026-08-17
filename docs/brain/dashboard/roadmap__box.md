# Dashboard · roadmap/box

_TODO: page purpose._

**Route:** `/dashboard/roadmap/box`

## Features

**Page title:** Build box

**Rendering:** `"use client"` component (client-side state + fetch).

### Live updates — Realtime Broadcast, not polling (roadmap-box-broadcast)

This page (and the roadmap board's `BoxChip`) **no longer poll** `/api/roadmap/box` on a timer (was 5s / 10s). They subscribe to the private per-workspace Realtime topic **`box:<workspace_id>`** via the shared hook [[../libraries/use-box-live]] and **refetch on each broadcast**, with a slow backstop (30s here / 60s for the chip) + a tab-return refresh for fire-and-forget safety. Three DB triggers feed that one topic (migration `20261203120000`):

- **[[../tables/agent_jobs]]** `agent_jobs_broadcast_trg` → lanes / queue / paused / failed / `session_checklist` streaming / status flips.
- **[[../tables/worker_heartbeats]]** `worker_heartbeats_broadcast_trg` → the box header's **`running_sha`** + liveness + lane usage. This is what answers *"which SHA is the box on / is it up?"* — `worker_heartbeats` updates every poll tick (~30s) and on restart but never touches `agent_jobs`, so it needs its OWN trigger or a SHA change on an idle box would only surface on the client backstop. It's a global singleton (no `workspace_id`), so it broadcasts to the single-tenant workspace's topic via the "oldest workspace" rule.
- **[[../tables/roadmap_chats]]** `roadmap_chats_broadcast_trg` → the authoring chat's `turn_status` (for `AuthoringChat` on the roadmap page).

So the box's SHA/liveness now pushes live every ~30s (the box's own heartbeat write broadcasts) and instantly on restart, and lane/queue changes appear the moment a job row changes — no steady polling. Uses **Broadcast** (not Postgres Changes — which has the open RLS/Walrus bug); see [[../recipes/realtime-subscriptions]].

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

**⭐ Historical dual-persona session cards (`box-page-shows-both-avatars-for-ping-pong-ad-creative-sessions`).** Earlier builds rendered two-avatar cards for multi-agent sessions, including an ad-creative-copy-author ping-pong and a fused pre-merge `spec-test` lane (`fused_pre_merge`). Both current paths are retired from the avatar renderer: ad-creative now follows the one-face rule below, and the fused pre-merge Vera + Vault session was retired 2026-07-17 (see [[../libraries/spec-check-runner]] § graduate-vera). A `spec-test` lane now shows Vera alone (her deterministic run), and the security review is Vault's own separate lane.

**⭐ One-face rule for the ad-creative ping-pong (`max-critique-reaches-dahlia-and-the-box-card-shows-one-face` Phase 3).** An `ad-creative-copy-author` job is a PING-PONG — Dahlia (ad-creative) authors a creative, then Max (ad-creative-copy-qc / growth grader) independently grades it, bouncing back and forth across the revise loop under ONE parent job — but only ONE sub-session is actually running at any moment. The pre-Phase-3 render (a `pingPongInfo` helper that always drew BOTH faces side-by-side, plus an `activePingPongPersona` regex over the session checklist that returned null most of the time and fell back to dual) hid which one was actually working. On the 2026-08-12 Amazing Coffee run that mask hid that Max's half had produced nothing usable — from outside the card it looked like both were collaborating fine. So:

- The card renders EXACTLY ONE face for `ad-creative-copy-author` — Dahlia while she authors / revises / does image-QC, Max while he grades. Choice is driven by the worker-stamped `agent_jobs.metadata.active_persona` — the two dispatcher-wrappers in `scripts/builder-worker.ts` (`copyAuthorDispatcher` + `qcDispatcher` in `runAdCreativeJob` + `runAdCreativeCopyAuthorJob` stamp `'ad-creative'`; `copyQcDispatcher` in both runners stamps `'ad-creative-copy-qc'`). The IMAGE-QC turn stamps `'ad-creative'` because that vision check runs INSIDE Dahlia's own loop on her own render (and `getPersona('ad-creative-qc')` resolves to a generic default persona today — never render it directly).
- The `/api/roadmap/box` route enriches every lane with the stamped `active_persona` alongside `session_note` / `session_checklist`, so the client reads it as `lane.active_persona`. The `activePingPongPersona(kind, activePersona)` helper on the page consumes it: `'ad-creative'` → Dahlia · `'ad-creative-copy-qc'` → Max · null / unstamped → OWNING persona (Dahlia, per [[../libraries/agents-personas]] `KIND_PERSONA_ALIAS['ad-creative-copy-author']`). NEVER two faces for this kind — the queued-job path (which cannot have a stamp yet) also renders the OWNING persona via `personaForKind`.
- The ping-pong is legible in the LABEL rather than the avatar: a `pingPongLabel(kind)` chip still names the pairing ("ad-creative ping-pong") next to the kind chip while the photo shows only the current actor.
- The stamp writer is best-effort (mirrors the `session_note` streaming guarantee): a failed metadata merge never breaks the run. Preserves other `metadata` keys via a read-merge-write; only the dispatchers write `active_persona` and they are sequential within a job, so the read-modify-write has no realistic race.

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
- `docs/brain/tables/agent_jobs.md` — `metadata.active_persona` is written by the ad-creative dispatcher-wrappers so the box card can render the current actor's single face (max-critique-reaches-dahlia-and-the-box-card-shows-one-face Phase 3)

---

[[../README]] · [[../../CLAUDE]]
