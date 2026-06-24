# inngest/security-dep-watch

The daily **CVE / dependency-upgrade watch** behind the **Security / Dependency Agent** ([[../specs/security-dependency-agent]] Phase 2). The sibling of the per-diff security pass: where Phase 1 reviews each merged diff, this watches the dependency tree for known CVEs / available security upgrades. Mirrors [[../specs/coverage-auto-register-agent|Cole]] / [[../libraries/repair-agent|Rafa]]: detect → propose → owner builds (**never auto-bumps**).

**File:** `src/lib/inngest/security-dep-watch.ts` (registered in `src/lib/inngest/registered-functions.ts` → served by `src/app/api/inngest/route.ts`)

## Functions

### `security-dep-watch`
- **Trigger:** cron `0 4 * * *` (daily)
- **Retries:** 1

## What it enqueues

It calls [[../libraries/security-agent]] `enqueueDepWatchJob` — inserting one `queued` [[../tables/agent_jobs]] row `kind='security-review'`, `spec_slug='security-dep-watch'`, `instructions={mode:'dep-watch'}`. The box claims it on its security-review lane (`scripts/builder-worker.ts` → `runSecurityReviewJob`, dep-watch mode), runs `npm audit --json` on the real tree, and on a ≥ moderate advisory **authors/refreshes the `security-dep-upgrades` fix spec to main + surfaces a one-tap owner Build card** (routed via [[../libraries/approval-router]]) + writes a [[../tables/director_activity]] row. A clean tree → the job completes silently. **Deduped** to ≤1 live scan + a 24h recent-window guard, so the daily beat never piles up.

## Why a cron that ENQUEUES a box job, not an in-cron scan

`npm audit` needs the npm CLI + the committed lockfile + registry access — none reliably present in the Vercel/Inngest serverless runtime. So this cron is the **scheduler** (deduped, heartbeat) and the box (which has the full repo + npm) runs the actual scan. The observable behaviour matches the spec.

## Monitored

Registered in `MONITORED_LOOPS` ([[../libraries/control-tower]], `id: 'security-dep-watch'`, `owner: platform`, `livenessWindowMs: 26h`, `registeredAt` for the first-tick grace) so a dead cadence is visible on [[../dashboard/control-tower]] and can't silently die — the [[../specs/coverage-auto-register-agent]] contract. Emits a `loop_heartbeats` beat (`loop_id='security-dep-watch'`) at end-of-run via `emitCronHeartbeat`.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box.

## Tables written

- [[../tables/agent_jobs]] (inserts the `security-review` dep-watch job)
- [[../tables/loop_heartbeats]] (end-of-run heartbeat)

## Tables read (not written)

- [[../tables/agent_jobs]] (the dedup scan — live + recent-window dep-watch jobs)

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/security-agent]] · [[../specs/security-dependency-agent]] · [[../../CLAUDE]]
