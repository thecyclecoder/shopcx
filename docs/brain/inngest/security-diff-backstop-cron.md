# inngest/security-diff-backstop-cron

The cheap **15-min if-due backstop** for Vault's post-merge `diff` security review ([[../specs/fix-vault-post-merge-diff-backstop-7fbde0]] cheap if-due cron backstop, on top of [[../specs/vault-post-merge-diff-backstop]] Phase 1). Sibling of the pre-merge [[spec-review-cron]] backstop — same enqueue-only pattern, same 15-min cadence, same idempotent dedup shape. **This cron does NO reasoning** — purely the enqueue.

**File:** `src/lib/inngest/security-diff-backstop-cron.ts` (registered in `src/lib/inngest/registered-functions.ts` → served by `src/app/api/inngest/route.ts`)

## Functions

### `security-diff-backstop-cron`
- **Trigger:** cron `*/15 * * * *` (every 15 minutes)
- **Concurrency:** 1 (never overlap)
- **Retries:** 1

## What it enqueues

It calls [[../libraries/security-agent]] `enqueueSecurityDiffIfDue`, which enumerates recently-merged `claude/*` builds (`agent_jobs` `kind='build'`, `status='merged'`, `updated_at` within the last 14d), resolves each build's merge SHA(s) via spec provenance ([[../tables/spec_phases]] `merge_sha` for multi-phase specs + card-level [[../tables/specs]] `last_merge_sha` for one-shots), and (idempotently) calls `enqueueSecurityReviewJob` in diff mode for each SHA. Idempotency comes for free from the 14d SHA dedup inside `enqueueSecurityReviewDiff` — this cron only enqueues genuinely-missing rows and is safe to run every 15 min.

## Why every 15 min (not the daily leg alone)

Vault's post-merge `diff` review has three legs closing the dropped-event gap:
1. **The merge hook** ([[../libraries/agent-jobs]] `applyMergedBuildEffects`) fires the enqueue reactively on every merge — the primary trigger.
2. **The platform-director standing pass** ([[../../../scripts/builder-worker]] `runPlatformDirectorStandingPass`) also runs `enqueueSecurityDiffIfDue` — a second net that fires only when the director agent is up.
3. **The daily [[security-dep-watch]] cron** hangs `enqueueSecurityDiffIfDue` off its 4am beat — a final net that catches a full outage.

The [[../specs/fix-vault-post-merge-diff-backstop-7fbde0]] pre-merge spec-test on 2026-07-02 observed `orphan_count=45` on prod anyway: the daily cron's 24h window is too coarse for the M4 pre-merge promote gate's post-merge orphan probe (`isSpecTestGreenForBranch`), and the standing pass isn't guaranteed to fire between a merge and the probe. This cron closes both gaps by running the same sweep every 15 min — cheap (bounded 500-row read + a dedup-guarded insert per orphan), short-window (largest orphan lag ≤ ~15 min), idempotent. Mirrors [[spec-review-cron]]'s cadence for the same class of dropped-event backstop.

## Monitored

Registered in `MONITORED_LOOPS` ([[../libraries/control-tower]], `id: 'security-diff-backstop-cron'`, `owner: platform`, `livenessWindowMs: ~60m`) so a dead cadence is visible on [[../dashboard/control-tower]] — the [[../specs/coverage-auto-register-agent]] contract. Emits a `loop_heartbeats` beat (`loop_id='security-diff-backstop-cron'`) at end-of-run via `emitCronHeartbeat`.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box.

## Tables written

- [[../tables/agent_jobs]] (inserts `security-review` diff-mode jobs for any orphaned merge SHA)
- [[../tables/loop_heartbeats]] (end-of-run heartbeat)

## Tables read (not written)

- [[../tables/agent_jobs]] (enumerating recently-merged `claude/*` builds)
- [[../tables/specs]] + [[../tables/spec_phases]] (resolving each build's merge SHA via provenance)

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/security-agent]] · [[../specs/vault-post-merge-diff-backstop]] · [[../specs/fix-vault-post-merge-diff-backstop-7fbde0]] · [[../../CLAUDE]]
