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

## Message-Center director-tab list (`/api/director/coach/directors`)
The Developer Message Center (`/dashboard/developer/messages`) renders a tab per live director alongside its hardcoded Eve (god-mode) tab. Because `MessageCenterChat` is a client component it cannot import server-only `getOrgChart` / `director-leash-guide`, so it fetches this shape from the owner-gated GET `/api/director/coach/directors` ([[../../src/app/api/director/coach/directors/route]]) once on mount:

```json
{ "directors": [ { "slug": "platform", "name": "Ada", "personaAccent": "text-indigo-600 …", "leashSummary": "Ship a fix for a confirmed bug · …" } ] }
```

The endpoint intersects `getOrgChart().directors.filter(d => d.live)` with `getRegisteredDirectorSlugs()` from `director-leash-guide.ts` (the set of function slugs with a registered `<name>-director.ts` leash module), so a director appears iff its backend can back a coach thread. Order = the org-chart's director order. Eve is deliberately excluded — she's CEO-owned, not a leash-bound director, and stays a hardcoded, visually-distinct tab. Non-owners get a 403 with `"Owner only"`; unauthed callers get 401. See `.box/spec-message-center-director-tabs.md` Phase 1.

## Founder-prompted out-of-leash escape valve
[[../specs/ceo-authorized-out-of-leash-actions]] — when the CEO asks Ada in this chat to do something OUTSIDE her leash (e.g. to unstick a wedged pipeline) she has a supervised path: investigate read-only, and IF she independently AGREES it's sound + the right call she emits ONE `out-of-leash-request` action in her reply. That action is **auto-applied inline** (`applyOutOfLeashRequestActionInline` in `scripts/builder-worker.ts`, mirroring `spec-status` / `dismiss-park` / `request-audit`): it raises a CEO-routed Approval Request (`kind='ceo-authorized-out-of-leash'`, `status='needs_approval'`) carrying her reasoning + a concrete executable pending-action (`run_prod_script` or `apply_migration`). The approval card ALWAYS displays the exact command line (`$ ${cmd}`) that will execute — if the preview exceeds 4000 chars, the user-supplied detail is truncated but the literal cmd is always re-appended. The CEO decides in the standard [[../dashboard/agents|Approvals inbox]] — **approval** flips the job to `queued_resume` and `runCeoAuthorizedOutOfLeashJob` (Phase 2) shell-executes the concrete `cmd` in the box's repo root as a SCOPED, ONE-TIME, `authorized_by='ceo'`-stamped run + writes ONE `executed_ceo_authorized_out_of_leash` [[../tables/director_activity]] row; **decline** closes the request cleanly with a `ceo_declined_out_of_leash_request` audit row and no execution. The leash config ([[../tables/function_autonomy]]) is UNTOUCHED — the next out-of-leash ask needs its own CEO approval. If she DISAGREES (unsound / risky / wrong), she emits NO action — the reply is her reasoning + what she'd do instead. That independent-agreement gate is what keeps her a supervisor, not a rubber-stamp: the founder's ask is necessary but NOT sufficient. See [[platform-director]] § Founder-prompted out-of-leash actions.

---

[[../README]] · [[../tables/director_coach_threads]] · [[director-instructions]] · [[dev-message-threads]] · [[../specs/worker-grading-and-director-management]] · [[../../CLAUDE]]
