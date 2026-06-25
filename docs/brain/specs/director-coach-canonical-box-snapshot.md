# director-coach-canonical-box-snapshot

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/platform-director-agent]] mandate — director narration accuracy
**Blocked-by:** none

## Why

In one director-coach session I confidently misread my own queries three times:
1. Filtered agent_jobs on `status in ('queued','running','in_progress','needs_attention')` — but the real in-flight enum is `building`; `running` and `in_progress` don't exist on this table. Read 'box is empty' off a broken query.
2. Doubled down by checking director_activity for pass cadence — but director_activity only logs write actions (flips, dismisses, fold-queues), not runs. Concluded 'no platform passes in 4 hours' when there had been 5 in the last 2.
3. Earlier same session, ran a wrong filter on platform-scorecard-surface and reported phantom phase drift.

The brain page docs/brain/tables/agent_jobs.md documents the status enum accurately (queued/building/needs_attention/needs_approval/queued_resume/blocked_on_usage/held/dismissed/completed/failed). I just didn't read it under the pressure to answer the CEO immediately. Hand-rolling SQL each turn is a recurring failure mode — same root every time.

Fix is structural: the coach turn prompt should already carry a fresh, accurate snapshot before I open my mouth. Director narrates from a typed payload, not from memory of column shapes.

## Phase 1 — snapshot library

Build `src/lib/agents/director-box-snapshot.ts`, single export `getDirectorBoxSnapshot(workspaceId, directorFunction)`. Bootstraps from `createAdminClient()`. Returns:

- `jobs`: counts + sample rows grouped by REAL status enum (`queued`, `building`, `needs_input`, `needs_approval`, `queued_resume`, `blocked_on_usage`, `held`, `needs_attention`, `dismissed`, recent `completed`/`failed` last 2h). Pulled from agent_jobs in one query.
- `recentDirectorPasses`: last 10 rows where `kind='platform-director'` ordered desc by completed_at — proves the standing pass is firing on cadence. Drawn from agent_jobs, NOT director_activity.
- `parkedByClass`: needs_attention rows grouped by `needs_attention_class`, with slug + age.
- `activeDirective`: the one active row from director_directives for this director, including `gate_builds_until`, `critical_specs`, age.
- `recentDirectorWrites`: my last 10 director_activity rows (flips, dismisses, fold-queues) — so the snapshot also shows what I've actually ACTED on, not just what's queued.

Document exports + columns in `docs/brain/libraries/director-box-snapshot.md`. Unit test (`director-box-snapshot.test.ts`) seeds an agent_jobs row per status and asserts the snapshot bucketizes correctly.

## Phase 2 — inject into coach prompt + post-reply sanity guard

In `scripts/builder-worker.ts` (the director-coach run path around `directorCoachFraming` + prompt assembly at ~line 6955), call `getDirectorBoxSnapshot()` per turn and inline the payload as a structured block prepended to `intentDirective`:

```
BOX SNAPSHOT (live, generated this turn):
- jobs: {building: 2, queued: 0, needs_attention: 19, needs_approval: 2, ...}
- platform-director passes (last 2h): 5, most recent 2026-06-25T01:35:06
- active directive: 10665e7a, age 2.5h, gate_builds_until=null, critical=[…]
- parked by class: routed_already_shipped:3, real_blocker:4, unknown:5, …
- recent flips (mine, 2h): agents-hub-role-inboxes (phase 5 → shipped), director-zero-backlog… (deferred → true)
```

When I'm asked about box state I narrate from THAT block.

Post-reply sanity guard: after I emit my reply text but BEFORE persist, the worker runs a cheap structural check — if the reply contains phrases like `"0 (queued|building|running|in_progress)"`, `"box is (empty|idle)"`, `"no (passes|activity)"`, or any of the status enum names with a count, the worker compares each claim against the snapshot it just generated. On a clear contradiction ("reply says 0 building, snapshot says ≥1"), the worker fails the turn with `error='narration drift — snapshot contradicts reply'` and surfaces it to the CEO instead of posting; I see the failure on the next turn and rewrite. Pattern-matched, not LLM-judged — cheap and high-precision.

## Phase 3 — backfill obvious narration-drift footguns

Audit my autonomous lanes (groom, init, escort in `src/lib/agents/platform-director.ts`) for any queries that filter agent_jobs by status. Replace ad-hoc enum lists with the canonical list exported from the snapshot library (e.g. `BOX_ACTIVE_STATUSES`, `BOX_PARKED_STATUSES`). One source of truth for what 'active' means; no lane drifts onto a wrong filter.

## Verification

- Fresh coach turn for any director carries a populated BOX SNAPSHOT block at the top of the prompt; counts match a direct agent_jobs query at the same instant.
- A scripted regression: queue an agent_jobs row in `building`, run a coach turn that asks 'is the box empty', assert the reply does NOT contain 'box is empty' / 'idle'; if I do, the sanity guard fails the turn.
- `grep -nE "status (=|in).*'(running|in_progress)'" src/lib/agents/` returns 0 hits after Phase 3.
- After ship, run one ASK turn against the live worker and confirm my reply names the actual job counts visible in the dashboard.
