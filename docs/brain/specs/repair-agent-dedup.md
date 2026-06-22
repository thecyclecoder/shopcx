# Repair Agent — dedup by root cause + skip already-fixed + cap auto-build ⏳

**Owner:** [[../functions/platform]] · **Parent:** hardens [[repair-agent]] (its first real run over-produced). · **Repair-meta:** the repairer repairing itself.

The Repair Agent's first live run (2026-06-22) **over-produced massively**: it authored **8 specs and opened 6 PRs for ~3 distinct root causes + 1 real bug**. Three failures compounded:
1. **No root-cause grouping** — four signatures (`loop:meta-capi-dispatch-cron`, `loop:marketing-text-…`, `loop:slack-roadmap-notify`, `supabase-logs:loop_heartbeats-500`) all traced to ONE root (the `control_tower_loop_beats` RPC failing → false `never_fired`), but it authored a separate spec per signature.
2. **No already-fixed check** — it fired on **stale `error_events`/`loop_alerts` that were still open from before our triage fixes deployed** (the never_fired + loop_heartbeats-500 that `control-tower-monitor-accuracy` had *just* shipped a fix for), so it re-diagnosed solved problems.
3. **Auto-build didn't dedup** — the `monitor-false-positive` allow-list auto-queued the **same spec's build 4×** (4 identical PRs `control-tower-beats-read-failure-guard`).

(It also did real good — it correctly found a genuine *regression* in the monitor-accuracy fix: a failed RPC read ≠ "0 beats ever". That fix shipped as `control-tower-beats-read-failure-guard` #203. The agent works; it just needs discipline.)

## Fix
- **Group by root cause before authoring.** Before authoring a spec for signature S, the agent must check whether a spec it's *about to author or has already authored this cycle* covers the same root cause (e.g. same implicated file + same failure mode) — and if so, **add S as another `Repair-signature:` to the existing spec** instead of a new one. One root cause → one spec, N signatures.
- **Skip already-addressed signatures.** Before diagnosing, check whether the signature's root cause is covered by a **recently-merged or in-flight spec** (a spec touching the same file/area shipped in the last N hours, or an open build/PR). If so → **resolve the error_event as "fixed by [[spec]], pending deploy"** and do NOT author. (The stale-open-error problem: an error recorded before its fix deployed must not re-trigger a repair.)
- **Dedup the auto-build.** The `REPAIR_AUTOBUILD_KINDS` path must enqueue **at most one build per spec slug** (check for an existing active build / open PR for that slug first). Never 4 PRs of one spec.
- **Cap per cycle.** A safety ceiling — if a single monitor tick / error burst would spawn more than K repair jobs, **batch them into one "investigate this cluster" job** rather than K independent ones (the cluster likely shares a cause).

## Verification
- A burst of N signatures sharing one root cause → **one** repair spec authored (carrying N `Repair-signature:` lines), **one** build, **one** PR — not N.
- An error whose root cause matches a spec merged in the last N hours (or an open PR) → the repair resolves it "fixed by [[spec]], pending deploy", authors nothing.
- An allow-listed auto-build verdict whose spec already has an active build/PR → no second build enqueued.
- Re-run the exact 2026-06-22 scenario (stale never_fired + loop_heartbeats-500 errors) against the fixed agent → it produces **0 new specs** (all already-fixed), where the unfixed agent produced 8.
- A genuinely-new, distinct bug (e.g. the OTP-start 502) → still gets its own spec (dedup doesn't suppress real distinct issues).

## Phase 1 — root-cause grouping + already-fixed skip + auto-build dedup ⏳
In `src/lib/repair-agent.ts` + `runRepairJob`: a root-cause key (implicated file + failure mode) that collapses sibling signatures onto one spec; an already-addressed check (recent-merged / open-PR for the area → resolve-pending-deploy, no author); auto-build dedup (≤1 build per slug); a per-cycle cluster cap. Brain: [[../libraries/repair-agent]] · [[repair-agent]] · [[control-tower]].
