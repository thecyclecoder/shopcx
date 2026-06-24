# Agent Roster Sync — full-visibility org view ✅

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/grow-surface-platform-agent-team]] · M1 — Roster sync

The org view ([[../dashboard/agents]]) must reflect **100% of running agents** — the goal's success metric ("the org view reflects 100% of running agents, reconciled to [[../tables/agent_jobs]] + personas, kept in sync"). Today it doesn't: [[../libraries/org-chart]] `getOrgChart()` derives the worker roster from `MONITORED_LOOPS` filtered to `kind === "agent-kind"` only, so personified platform **crons** — Tao/`monitor` (`control-tower-monitor`, which has **no** `agentKind`), Devi/`db_health` (`db-health-slow-query` / `db-health-size-sweep`), Cole/`coverage-register` — are invisible, and Remi/`regression` is in [[../libraries/agent-personas|PERSONAS]] with an `agent-kind` lane but **never fires** with no inactive flag. This spec reconciles the three roster sources — `MONITORED_LOOPS` (cron + agent-kind) ↔ `PERSONAS` ↔ live `agent_jobs` lanes — into one brain-driven reader and keeps them in sync.

## North star — the objective-owner's full window
Per the supervisable-autonomy north star ([[../operational-rules]] § North star), the CEO can only supervise proxy-optimizing tools it can **see**. A hidden agent is an unsupervised agent. This spec closes the visibility gap (no hidden agents) and flags the dead ones (Remi) so the roster is an honest projection of what's actually running — never a hand-maintained second copy.

## Phase 1 — reconcile the three sources into one roster reader ✅
- ✅ shipped — `buildRoster()` in `src/lib/agents/org-chart.ts` replaces `workersForFunction()`; it unions agent-kind lanes + `personaKind` crons (deduped by persona key — the two `db-health-*` crons merge into ONE Devi) + live `agent_jobs.kind` orphans (flagged). `personaKind` added to `MonitoredLoop` and set on `control-tower-monitor`→`monitor` (Tao) + both `db-health-*`→`db_health` (Devi).
- Extend `workersForFunction()` in `src/lib/agents/org-chart.ts`: today it returns `MONITORED_LOOPS.filter(l => l.kind === "agent-kind" && l.owner === slug && l.agentKind)`. Broaden it to surface **every persona-backed loop** owned by the function — `agent-kind` lanes **and** `cron` loops that resolve to a [[../libraries/agent-personas|persona]] via `getPersona` (e.g. `control-tower-monitor`→Tao, `db-health-*`→Devi, `coverage-register`→Cole).
- Add a roster-linkage field to `MonitoredLoop` in `src/lib/control-tower/registry.ts` for cron loops that map to a worker persona (e.g. `personaKind?`), so `control-tower-monitor` (no `agentKind`) and the `db-health-*` crons declare their persona explicitly rather than by guesswork. Keep `agentKind` as-is for the queue lanes.
- Union in any live `agent_jobs.kind` ([[../tables/agent_jobs]]) that has recent rows but no `MONITORED_LOOPS` row — so a lane that exists in the queue but not the registry still shows (flagged, see Phase 3), never silently dropped.
- `getPersona` already falls back to a neutral persona for an unknown slug, so a newly-rostered cron reskins with no code change (brain-driven).

### Verification — Phase 1
- On `/dashboard/agents`, the Platform director shows Tao/monitor, Devi/db_health, and Cole/coverage-register as workers (they are absent today) alongside the existing `agent-kind` lanes (Bo, Rafa, Remi, …).

## Phase 2 — liveness / inactive flagging ✅
- ✅ shipped — `computeWorkerStatus()` derives `active` / `idle-healthy` / `inactive` per worker from `agent_jobs` recency (7-day window) + `loop_heartbeats` beats; `inactive` = zero `agent_jobs` rows ever (Remi), graced by a `registeredAt` window + the cron-backed exemption (mirrors `evalCron`). Surfaced via the new `WorkerStatusBadge` (`persona-chip.tsx`) on the workers roster + org tree, plus an `unregistered` chip for flagged lanes.
- For each rostered agent compute a live status from `agent_jobs` recency + [[../tables/loop_heartbeats]] beats: **active** (a recent job/beat), **idle-healthy** (no work but beating), **inactive / never-fired** (a persona + lane that has produced **zero** `agent_jobs` rows ever — e.g. Remi/`regression`).
- Mirror the [[../libraries/control-tower]] `evalCron` never-fired grace so a freshly-shipped or genuinely-idle lane is **not** falsely flagged inactive (distinguish "never fired in all history" from "idle but healthy").
- Surface the status on the workers roster (`src/app/dashboard/agents/workers/page.tsx`) + the org tree (`src/components/agents/org-tree.tsx`) via the existing `StatusBadge` ([[../libraries/agent-personas]] `persona-chip.tsx`) — an explicit "inactive" badge on Remi.

### Verification — Phase 2
- On `/dashboard/agents/workers`, Remi/regression renders with an **inactive** badge (it has never fired), while Bo/build and a beating cron render active/idle-healthy.

## Phase 3 — drift guard, keep-in-sync ✅
- ✅ shipped — `scripts/audit-agent-roster.ts` reconciles the three sources via the SAME `buildRoster()` reader and reports three drift categories (`persona-without-loop` · `loop-without-persona` · `live-lane-unregistered`); clean registry prints "0 drift", deleting a rostered loop names that exact mismatch. Brain folded into [[../dashboard/agents]] + [[../libraries/agent-personas]].
- Add a reconciliation check (a script `scripts/audit-agent-roster.ts` and/or an extension of the [[../libraries/control-tower]] self-audit) that flags any drift among the three sources: a `PERSONAS` entry with no `MONITORED_LOOPS` row; a persona-backed loop not rostered; a live `agent_jobs.kind` absent from `MONITORED_LOOPS`. Surface a one-line board-watch / control-tower amber so roster ↔ personas ↔ lanes can't silently diverge again (the drift the goal found on 2026-06-24).
- Brain: fold the reconciled-roster behavior into [[../libraries/org-chart]] + [[../libraries/agent-personas]] + [[../dashboard/agents]].

### Verification — Phase 3
- Running `scripts/audit-agent-roster.ts` prints zero drift; removing a persona's loop row makes it print exactly that mismatch.

## Safety / invariants
- The roster stays a **brain-driven projection** of `functions/` + `MONITORED_LOOPS` + `PERSONAS` + live `agent_jobs` — never a hand-maintained second copy of the org chart ([[../libraries/org-chart]]).
- Inactive detection must never false-flag an idle-but-healthy or freshly-shipped lane as dead (reuse the `evalCron` never-fired grace).
- Read-only: surfacing only — this spec never enqueues, mutates, or kills any agent.

## Completion criteria
- `/dashboard/agents` surfaces 100% of running agents, including the previously-invisible Tao/monitor, Devi/db_health, Cole/coverage-register and `control-tower-monitor`.
- Inactive personas (Remi/regression) carry an explicit inactive badge, distinct from idle-healthy.
- A drift check flags any roster ↔ personas ↔ live-lanes mismatch and surfaces it; clean state prints zero drift.

## Verification
- On `/dashboard/agents` (Org chart view, owner-only), view the Platform director column → expect **Tao/monitor** and **Devi/DB Health** listed as worker nodes (each was invisible before this spec — they're `cron` loops, not `agent-kind` lanes), each carrying a live status badge (active when beating). `coverage-register`/Cole appears as a flagged worker **iff** it has had an `agent_jobs` row in the last 7 days.
- On `/dashboard/agents/workers`, find **Remi/regression** → expect a red **inactive** badge (0 `agent_jobs` rows in all history), while **Bo/build** and a beating cron (Tao/Devi) read **active**. A lane unioned in from a live queue kind with no registry row also shows an amber **unregistered** chip.
- Run `npx tsx scripts/audit-agent-roster.ts` (needs DB env — runs on the box / locally with `.env.local`) → it prints the reconciled roster then the **Drift** block. With a clean registry it prints `0 drift`; any live lane without a `MONITORED_LOOPS` row (e.g. `coverage-register`) is named under `[live-lane-unregistered]`. Remove `personaKind: "monitor"` from `control-tower-monitor` (or any rostered loop) and re-run → expect a `[persona-without-loop]` line naming exactly `Tao/monitor`.

## Related
[[../libraries/org-chart]] · [[../libraries/agent-personas]] · [[../libraries/control-tower]] · [[../tables/agent_jobs]] · [[../dashboard/agents]] · [[../goals/grow-surface-platform-agent-team]]
