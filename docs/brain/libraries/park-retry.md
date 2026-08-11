# libraries/park-retry

Decides whether a parked `agent_jobs` row should be **re-driven** before it becomes a founder's unactionable card.

**File:** `src/lib/agents/park-retry.ts` · **Test:** `src/lib/agents/park-retry.test.ts` (`npm run test:park-retry`) · **Caller:** [[needs-attention-route]] `routeBackstop`

## Why it exists — a dropped finding, not just a noisy card

A `needs_attention` park is effectively terminal: nothing retries it, and the founder **cannot act on it either** — [[roadmap-actions]] `approveRoadmapAction` hard-requires `needs_approval`, so a park card can only ever offer *Dismiss*. When the thing that CAUSED the park is a code-side defect, fixing that defect does not revive the parked work; it just leaves a card describing a problem that no longer exists.

**Ground truth, 2026-08-10/11.** June (`cs-director-call`) found a real product gap — internal renewal orders were not injecting the customer's name into `shippingAddress` — and tried to author a spec for it. The author chokepoint rejected her seed at **14:25:39Z** because a phase carried no machine-runnable check. That authoring defect shipped fixed in #2424 at **14:30:14Z — 4 minutes 35 seconds later**, and all three `cs-director-call` jobs that ran afterwards completed cleanly. But the parked job was never re-driven, so:

- the spec was **never authored** — June's finding was silently lost (the underlying bug survived only because a human happened to fix it by hand in #2436), and
- the founder was left with a card titled `Park needs eyes: 1eddd352-ad99-4173-95fa-89b9dff49712`, bodied with a raw error dump, describing a **doubly-obsolete** problem, offering nothing but *Dismiss*.

**The lost work is the serious half.** A card is noise; a dropped finding is a defect that ships.

## The rule

Re-drive when BOTH hold:

1. **The kind is safely re-runnable** — `RERUNNABLE_JOB_KINDS`, the same set the worker's startup orphan-reaper already re-queues on the grounds that a re-run loses no work. `build` is excluded (it produces a branch + PR; a re-run is not free).
2. **The error is a deterministic code-side rejection** — a validation rail said no. Those are exactly the failures a subsequent deploy can fix, which is what makes "try again later" meaningful.

Deliberately **not** retried: infrastructure/outage errors (a retry there is a coin flip) and anything ambiguous. `isRetryableParkError` returns `false` when unsure, and the park escalates exactly as it does today.

## Bounds

| Knob | Default | Why |
|---|---|---|
| `PARK_RETRY_MAX` | 2 | A genuinely broken job costs a small fixed number of cheap re-runs, then escalates. |
| `PARK_RETRY_MIN_INTERVAL_MS` | 6h | **The spacing is the point** — it straddles a DEPLOY. Retrying a validation rejection 30s later just reproduces it. |

The count is read off the [[../tables/director_activity]] ledger (`action_kind='park_retry'`, `metadata.job_id`), so it survives a worker restart — in-memory state would silently reset the cap. The history read **fails CLOSED**: a DB blip reports the cap as reached, so a transient error can never turn the bounded re-drive into a loop.

On cap exhaustion the escalation finally says something useful: *"re-driven N times across deploys, still failing."*

## Exports

- `decideParkRetry({ kind, error, priorRetries, lastRetryAt, now })` → `{ retry, reason }` — pure; every branch carries a human-readable reason so the ledger and the escalation are auditable.
- `isRetryableParkError(error)` → `boolean` — pure signature match.
- `RERUNNABLE_JOB_KINDS` — **single source of truth**, imported by `scripts/builder-worker.ts` (which re-narrows it to `Job["kind"]`) so the worker's reaper and this rung cannot drift.
- `PARK_RETRY_MAX` · `PARK_RETRY_MIN_INTERVAL_MS`.

## ⚠️ Why this is a `src/lib/` module

`RERUNNABLE_JOB_KINDS` lives here rather than in `scripts/builder-worker.ts` because **importing that module boots the worker** (module-level main loop + reaper) — a unit test that did so once healed a developer's git worktree back to main and discarded uncommitted work. Same rule as [[predeploy-guard-extract]]: a pure helper the worker needs that anything else must also import belongs in `src/lib/`.

## Related

[[needs-attention-route]] · [[predeploy-guard-extract]] · [[approval-inbox]] · [[../tables/agent_jobs]] · [[../tables/director_activity]]
