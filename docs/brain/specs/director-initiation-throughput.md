# Initiation throughput — clear the eligible backlog per pass + lean toward initiate ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[director-initialize-platform-specs-no-wait]] — opens the throughput throttle on the initiation lane under [[../goals/devops-director]]
**Found in use 2026-06-24:** the CEO observed 'plenty of platform specs aren't starting — can you only analyze one per pass?' Confirmed: `scripts/builder-worker.ts` `initiatePlatformSpecs` pulls only `PLATFORM_DIRECTOR_INIT_CAP` candidates per standing pass and loops them SEQUENTIALLY (a full Max soundness investigation each), on the ~15-min [[../inngest/platform-director-cron]] beat. So the eligible backlog trickles a few specs per pass over an hour+ (9 platform specs not-shipped, only 2 moving). And the mandatory soundness gate escalates specs it can't instantly confirm — the last 90 min of activity is mostly `init_unsure` escalations — flooding the CEO inbox instead of building sound specs.

## North star — faster, but the rails hold

Throughput up does NOT mean blind-build. The soundness investigation stays (no blind builds — the CEO's 2026-06-24 rail); the loop-guard + active-build dedup stay; destructive / new-goal / out-of-scope still escalate. This only (a) stops the per-pass trickle and (b) stops escalating specs that are actually sound.

## Phase 1 — clear the eligible backlog in one pass (throughput) ⏳
- Replace the sequential, low-capped loop with BOUNDED-PARALLEL soundness investigations across all eligible candidates: raise `PLATFORM_DIRECTOR_INIT_CAP` substantially (or make it the full eligible set) and run the per-candidate `runDirectorClaude` investigations concurrently up to a sane concurrency limit (respecting the box's Max session limits), so ONE standing pass clears the eligible platform backlog instead of a few specs. Keep loop-guard + `hasActiveBuildForSlug` dedup unchanged.
- Optional cheap pre-screen: a fast structural check (platform-owned, unblocked, non-deferred, non-destructive, has Verification) fast-tracks obviously-sound specs and reserves the full Max investigation for genuinely ambiguous ones — cuts cost and latency.
- Brain: [[../libraries/platform-director]] (`findInitCandidates`, `PLATFORM_DIRECTOR_INIT_CAP`) · `scripts/builder-worker.ts` `initiatePlatformSpecs`.

### Verification — Phase 1
- With several eligible platform specs queued, ONE standing pass initiates ALL the sound ones (not a capped few); each writes an `escorted_init` activity row. A spec with an active build is still not double-queued; a build that failed ≥ loop-guard cap still escalates.

## Phase 2 — calibrate the gate toward initiate (cut the escalation noise) ⏳
- For a PLATFORM-owned spec, the soundness verdict should INITIATE when the spec is sound + in-scope (the CEO's standing 'build platform specs that check out' direction). Reserve ESCALATE for genuinely destructive / irreversible / new-goal / out-of-scope / unconfirmable — NOT mild uncertainty. Tighten `initInvestigationPrompt` so a sound, in-scope platform spec is initiated, not parked as `init_unsure`.
- Net: your inbox stops filling with 'Initiation needs a call' on sound specs; you only see the genuinely high-stakes ones.

### Verification — Phase 2
- A sound, in-scope, unblocked platform spec → initiated (not escalated). A destructive / new-goal / out-of-scope spec → still escalated. The ratio of init_unsure escalations to initiations drops sharply on the next passes.

## Open decision (for the CEO)
How far to open it: (a) assess ALL eligible per pass with a concurrency cap (fastest; default), or (b) a higher fixed cap (e.g. 8/pass) if you want to bound box load. And whether to keep the full Max investigation for every platform spec or let the cheap pre-screen fast-track obviously-sound ones (recommended — faster + cheaper, same rails). Default: assess-all with a concurrency cap + the pre-screen fast-track.