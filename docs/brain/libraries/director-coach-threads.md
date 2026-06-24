# `src/lib/agents/director-coach-threads.ts` — the CEO↔Director coaching chat helpers

Server helpers for the [[../tables/director_coach_threads]] conversation ([[../specs/worker-grading-and-director-management]] Phase 7). Mirrors [[dev-message-threads]]: each CEO turn enqueues a `kind='director-coach'` [[../tables/agent_jobs]] row the box runs as a resumable Max session AS the director (she explains read-only); the durable coaching write is [[director-instructions]] `coachDirector`.

## Exports

| Symbol | Notes |
|---|---|
| `createThread({workspaceId, userId, directorFunction?, message})` | New thread with the opening CEO message. |
| `loadThread(workspaceId, id)` | One thread, workspace-scoped. |
| `markThreadThinking(workspaceId, id, userMessage?)` | Append an optional CEO message + flip `turn_status='thinking'` (clears prior error). |
| `setActionDecision(workspaceId, id, actionId, decision)` | Approve/decline a `coaching`/`spec` card; approve flips to `thinking` (the worker executes it). |
| `listRecentThreads(workspaceId, userId, limit?)` | The resume list. |

**Types:** `DirectorCoachThread`, `CoachThreadAction` (`type ∈ coaching｜spec`), `ThreadMsg`, `TurnStatus`.

## The two-button intent
The route ([[../../src/app/api/director/coach/route]]) sets `intent` on a turn: **Ask** (explain only) vs **Coach her** (distill into a `coaching` card). The box (`runDirectorCoachJob`) branches its framing on `intent`; the approval card is the explicit confirmation. Owner-gated at the route/UI; surfaced as `DirectorCoachChat` on her profile (`/dashboard/agents/platform`).

---

[[../README]] · [[../tables/director_coach_threads]] · [[director-instructions]] · [[dev-message-threads]] · [[../specs/worker-grading-and-director-management]] · [[../../CLAUDE]]
