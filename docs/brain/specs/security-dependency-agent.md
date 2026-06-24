# Security / Dependency Agent ✅

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/grow-surface-platform-agent-team]] · M3 — Security / Dependency agent

Auto-merging fixes (so the CEO never handles routine errors, [[director-zero-backlog-error-autonomy]]) opened a real safety gap: **no autonomous security pass on what gets merged**. Security today is only the human-invoked `/security-review` + `/code-review` skills; the agent roster ([[../libraries/agent-personas|personas.ts]] / the [[../libraries/control-tower|Control Tower registry]]) has build/repair/regression/coverage lanes but **none owns "review each merged diff for vulnerabilities" or "watch dependencies for CVEs"** — the unguarded half the auto-merge opened (the sibling gap to [[deploy-health-rollback-guardian]]'s "did this deploy regress prod"). This spec adds a new DevOps worker — a new `agent_jobs` kind / `agent-kind` lane + persona, mirroring Reva/Remi/Cole — that gives **every merged diff an autonomous security pass** (the goal's success metric) and watches dependencies for CVEs.

## North star — the supervisor on the auto-merge proxy
Auto-merge optimizes "ship the fix"; its degenerate state is shipping a fix that introduces an injection / secret-leak / authz hole. This agent is the security supervisor on that proxy: **review read-only and escalate**, never auto-mutate. It investigates the diff, classifies findings, and surfaces/escalates via the [[../libraries/approval-router|approval router]] — the owner-gated build (or a human) applies any fix. Mirrors the [[regression-agent|Regression Agent]] invariant: diagnose + author/surface, never edit product code itself.

## The agent — a new DevOps worker (persona reskinnable)
A new `agent_jobs.kind` (proposed `security-review`) on its own concurrency-1 lane, registered as a `MONITORED_LOOPS` `agent-kind` tile (owner `platform`, `agentKind: "security-review"`, a `stuckThresholdMs`) + a [[../libraries/agent-personas|persona]] in `personas.ts` / `RESPONSIBILITIES`. Proposed name: **Vault — Security Guardian** (🔒). Auto-surfaces on the org view via the `agent-kind` roster path ([[../libraries/org-chart]] `workersForFunction`).

## Phase 1 — per-diff security review on every merged `claude/*` diff ✅
- ✅ shipped — `security-review` job kind + lane; `enqueueSecurityReviewJob` fired from the merge hook ([[../libraries/agent-jobs]] `applyMergedBuildEffects`, deduped by merge SHA); `runSecurityReviewJob` (diff mode) reviews the merged diff read-only on Max, classifies, authors a fix spec + surfaces a `security_build` Build card routed via [[../libraries/approval-router]], writes a [[../tables/director_activity]] row.
- Fire from the **existing merge hook** the way `spec-test` and `pr-resolve` ride events: on a merged `claude/*` build PR, `reconcileMergedJobs` ([[../libraries/agent-jobs]]) / the [[../integrations/github-webhook|GitHub webhook]] enqueues one `security-review` job (`enqueueSecurityReviewJob`, deduped by merge SHA; `spec_slug` = the merged spec slug / `pr-{number}`).
- The worker (`runSecurityReviewJob` in `scripts/builder-worker.ts`) claims it on its concurrency-1 lane and runs a `claude -p` on Max (read-only, no `ANTHROPIC_API_KEY`, keeps read-only DB/crypto secrets) running the **`/security-review`** skill's checks over the merged diff: injection, secret/credential leak, authz / RLS-policy regressions, unsafe `createAdminClient()` exposure, `_encrypted` handling.
- ACT: classify each finding (`real-vuln｜needs-human｜false-positive`). On a real/ambiguous finding, route via [[../libraries/approval-router]] `resolveApproverLive("platform")` — a live+autonomous director escalates within its leash, else the CEO inbox (`needs_approval`) — and author a scoped fix spec to main + surface a Build card (owner-gated, mirrors [[repair-agent]] `repair_build`). Write a [[../tables/director_activity]] row (`director_function: 'platform'`) per detect/dismiss/escalate. **Never** edits product code, opens its own PR, or auto-applies a fix.

### Verification — Phase 1
- A merged `claude/*` diff with no issue → a logged `security-review` job, a clean verdict, no action. A diff that adds an obvious injection / leaked secret → a flagged finding surfaced to the platform approver + a `director_activity` row, with **no** auto-mutation.

## Phase 2 — CVE / dependency-upgrade watch ✅
- ✅ shipped — daily [[../inngest/security-dep-watch]] cron (`0 4 * * *`, a `MONITORED_LOOPS` `cron` tile owned by `platform`, with `registeredAt`) enqueues a `dep-watch` `security-review` job; `runSecurityReviewJob` (dep-watch mode) runs `npm audit --json` on the real tree and, on a ≥ moderate advisory, authors/refreshes the `security-dep-upgrades` fix spec to main + surfaces a Build card (never auto-bumps). `npm audit` runs on the box (where npm + the lockfile live), not in the serverless cron — see [[../libraries/security-agent]].
- A daily cron (`inngest/security-dep-watch`, a `MONITORED_LOOPS` `cron` tile owned by `platform`, with a `registeredAt`) scans `package.json` + the lockfile for known-vulnerable deps / available **security** upgrades (e.g. `npm audit` / an advisory feed).
- On a finding, **author a scoped upgrade-fix spec to main** + surface a one-tap owner Build card (never auto-bumps a dependency — the owner-gated build does the bump + `tsc` gate), mirroring [[coverage-auto-register-agent|Cole]] / [[repair-agent|Rafa]]. Write a `director_activity` row.

### Verification — Phase 2
- A seeded vulnerable/outdated dependency → the daily watch authors an upgrade-fix spec + surfaces a Build card; a clean tree → no spec, a healthy beat.

## Phase 3 — surface on the org view + brain ✅
- ✅ shipped — `security-review` agent-kind tile + `security-dep-watch` cron tile registered in [[../libraries/control-tower]] `MONITORED_LOOPS` (owner `platform`); the lane auto-surfaces on `/dashboard/agents` via the `agent-kind` roster path ([[../libraries/org-chart]] `workersForFunction`). Persona **Vault — Security Guardian** (🔒) + responsibilities added to [[../libraries/agent-personas|personas.ts]]. New brain pages [[../libraries/security-agent]] + [[../inngest/security-dep-watch]]; cross-linked from [[../integrations/github-webhook]] · [[../libraries/approval-router]] · [[../tables/director_activity]] · [[../libraries/agent-jobs]].
- The new `security-review` lane appears on `/dashboard/agents` automatically via the `agent-kind` roster path (and the [[agent-roster-sync]] reconciliation when it ships). Persona + responsibilities added to `personas.ts`.
- Brain: new `libraries/security-agent` + `inngest/security-dep-watch` pages; register both in [[../libraries/control-tower]] `MONITORED_LOOPS`; cross-link [[../integrations/github-webhook]], [[../libraries/approval-router]], [[../tables/director_activity]].

### Verification — Phase 3
- On `/dashboard/agents`, the Platform director lists the Security Guardian lane with its responsibilities; the Control Tower shows the per-diff lane + the dep-watch cron tile green when idle.

## Safety / invariants
- **Read-only review, never auto-mutating**: the agent investigates the diff/deps and authors/surfaces a fix or escalation — it never edits product code, opens its own PR, or bumps a dependency. The owner-gated build applies any fix (mirrors [[repair-agent]] / [[regression-agent]]).
- Ambiguity escalates (`needs-human`) via the [[../libraries/approval-router|approval router]] — hitting a rail = escalate, not execute ([[../operational-rules]] § North star).
- Secret/credential findings are referenced by location, **never** echoed in plaintext into logs / `director_activity` / the surfaced spec.
- Deduped by merge SHA (per-diff) so a re-run never double-files.

## Completion criteria
- Every merged `claude/*` diff gets an autonomous security pass that classifies findings and escalates/surfaces them owner-gated, with a `director_activity` audit row.
- A daily CVE/dependency watch authors owner-gated upgrade-fix specs on a real finding, never auto-bumping.
- The new lane + dep-watch cron are registered in `MONITORED_LOOPS` and visible on `/dashboard/agents` + the Control Tower.

## Verification
- On `/dashboard/branches`, squash-merge a `claude/*` build PR whose diff adds a hardcoded secret or an unguarded `createAdminClient()` route → expect a `security-review` `agent_jobs` row (kind=`security-review`, instructions.mode=`diff`) that lands `needs_approval` with a `security_build` pending action (a fix spec authored to `docs/brain/specs/` on main) + a `director_activity` row (`director_function='platform'`, `action_kind='authored_fix'`), surfaced as a routed Approval Request in the CEO inbox — and **no** product-code mutation / no agent-opened PR.
- On `/dashboard/branches`, squash-merge a clean `claude/*` build PR → expect a `security-review` job that completes with a clean verdict (log_tail `clean`/`false-positive`), no pending action, no spec.
- In the CEO inbox, **Approve** the `security_build` card → expect the job to flip `queued_resume` then `completed`, and a `kind='build'` `agent_jobs` row queued for the authored fix spec (it opens its own PR; the merge stays owner-gated). **Decline** → job `completed`, no build queued.
- On `/dashboard/developer/control-tower`, view the tiles → expect an `agent:security-review` agent-kind tile and a `security-dep-watch` cron tile, both green when idle (the cron amber "awaiting first run" until its first 04:00 UTC tick).
- On `/dashboard/agents`, open the Platform director → expect the **Security Guardian (Vault, 🔒)** lane listed with its responsibilities (via the `agent-kind` roster path).
- Add a known-vulnerable dependency (≥ moderate advisory) to `package.json` + lockfile and let `security-dep-watch` run (or enqueue a `security-review` job with `instructions={mode:'dep-watch'}`) → expect `npm audit` to flag it, the `security-dep-upgrades` fix spec authored/refreshed to main, a `security_build` Build card surfaced, and a `director_activity` row — never an auto-bump. A clean tree → the job completes silently with a healthy heartbeat, no spec.

## Related
[[../libraries/approval-router]] · [[../integrations/github-webhook]] · [[../tables/director_activity]] · [[../libraries/control-tower]] · [[../libraries/agent-personas]] · [[regression-agent]] · [[repair-agent]] · [[deploy-health-rollback-guardian]] · [[../goals/grow-surface-platform-agent-team]]
