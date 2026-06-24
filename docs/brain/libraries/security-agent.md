# libraries/security-agent

The queue plumbing + autonomy policy behind the **Security / Dependency Agent** box worker ([[../specs/security-dependency-agent]]) — a worker the [[../specs/platform-director-agent|Platform/DevOps Director]] supervises. Persona: **Vault — Security Guardian** (🔒, [[agent-personas]]). It is **the supervisor on the auto-merge proxy**: auto-merge optimizes "ship the fix"; its degenerate state is shipping a fix that introduces an injection / secret-leak / authz hole. Vault gives **every merged diff an autonomous security pass** and **watches dependencies for CVEs** — review read-only + author/surface a fix, **never auto-mutate**.

**File:** `src/lib/security-agent.ts` · the box runner is `scripts/builder-worker.ts` `runSecurityReviewJob` (see [[../recipes/build-box-setup]]).

## North star — review + escalate; the owner-gated build disposes

The agent **reviews + classifies** (a bounded proxy: "did this diff/dep introduce a vulnerability + here's the fix"); the **owner-gated build applies any fix** and is graded on whether it held ([[../operational-rules]] § North star). It NEVER edits product code, opens its own PR, or bumps a dependency. Mirrors [[repair-agent]] / [[regression-agent]]: diagnose + author/surface, the disposer builds. Ambiguity escalates (`needs-human`). Every detect/escalate/author writes a [[../tables/director_activity|director_activity]] row (`director_function: 'platform'`). **Secret findings are referenced by location, never echoed in plaintext** into logs / `director_activity` / the surfaced spec.

## Two modes (one lane, `agent_jobs.kind='security-review'`)

- **`diff`** (Phase 1) — a **per-merged-diff** security pass. Reviews the merged `claude/*` commit for injection, secret/credential leak, authz / RLS-policy regressions, unsafe `createAdminClient()` exposure, and `_encrypted` handling (the [[../specs/security-dependency-agent]] / `/security-review` checklist + CLAUDE.md invariants).
- **`dep-watch`** (Phase 2) — the daily **`npm audit`** CVE scan (enqueued by [[../inngest/security-dep-watch]]). On a vulnerable dep it authors a scoped upgrade-fix spec + surfaces a Build card — never auto-bumps.

## Exports

- `type SecurityVerdict = "real-vuln" | "needs-human" | "false-positive"` — the box's per-diff classification (`clean` is a no-action terminal alongside `false-positive`).
- `SECURITY_DIRECTOR_FUNCTION = "platform"` — the function whose objective supervises this worker.
- `SECURITY_DEP_UPGRADE_SLUG = "security-dep-upgrades"` — the stable slug of the dep-upgrade fix spec (find-or-update, never N of them).
- `SECURITY_DEP_WATCH_SLUG = "security-dep-watch"` — the sentinel `spec_slug` a dep-watch scan job carries (so it dedups distinctly from per-diff jobs).
- `SECURITY_RECENT_FIX_WINDOW_MS` (24h) — a fix authored within this window is "pending deploy"; don't re-scan/re-surface.
- `LIVE_SECURITY_STATUSES` — the statuses that mean a security-review job is still live (working or surfaced).
- `securitySha12(mergeSha)` / `depFindingSignature(findings)` — the per-diff dedup key (the merge SHA) and the advisory-set signature (sorted `pkg@severity`, sha1).
- `enqueueSecurityReviewJob(admin, { mergeSha, specSlug, prNumber?, workspaceId? })` → enqueue ONE per-diff `security-review` [[agent_jobs]] job. **Deduped by the merge SHA** — a re-run (the two merge-hook paths firing for one merge) never double-files. **Best-effort, never throws.**
- `enqueueDepWatchJob(admin, { workspaceId? })` → enqueue the daily dep-watch scan. Deduped to ≤1 live scan + a recent-window guard. **Best-effort, never throws.**
- `getOpenSecurityReviews(admin, workspaceId)` → `SecuritySurfaceItem[]` — READ-ONLY: open security items awaiting the owner (`needs_approval` = a routed fix with a `security_build` Build action, or `needs_attention` = needs-human). Clean reviews complete silently.

## Trigger — event-driven (Phase 1) + a daily cron (Phase 2)

- **Phase 1** rides the **merge hook**: [[agent-jobs]] `applyMergedBuildEffects` (the shared body of BOTH `reconcileMergedJobs` — a manual squash-merge — and `handleAutoMergedBuildBranch` — the auto-merge webhook) calls `enqueueSecurityReviewJob` with the merge SHA. So every merged `claude/*` build diff gets exactly one review, deduped by SHA.
- **Phase 2** is the [[../inngest/security-dep-watch]] daily cron → `enqueueDepWatchJob`.

## The box loop — `runSecurityReviewJob`

1. **Disposer resume** — a routed `security_build` action approved (queue the build) / declined (dismiss).
2. **`dep-watch` mode** — run `npm audit --json` on the real tree; collect ≥ moderate advisories; on a finding author/refresh `security-dep-upgrades` to main + route; clean tree → complete silently with a healthy beat.
3. **`diff` mode** — `git fetch origin main` + `git show {sha}` read-only on Max → ONE verdict:
   - `clean` / `false-positive` → complete, no action.
   - `needs-human` → `needs_attention` + an `escalated` activity row, no spec.
   - `real-vuln` → **author the fix spec to main** (`authorSecurityFixSpec`, `Fixes: [[merged-slug]]`), then `routeSecurityFix` via `resolveApproverLive('platform')` ([[approval-router]]): a live+autonomous director auto-queues the build within its leash; else surface a `security_build` Build card for the **CEO inbox** (the generic [[../specs/approval-routing-engine|approval-inbox]] reconciler emits the routed request — no per-agent route needed). Records `authored_fix`.
   - **Unparseable/unrecognized verdict** ([[../specs/needs-attention-triage-and-verdict-robustness]] Phase 2) → the shared `resolveReviewVerdict` helper (shared with [[repair-agent]] + [[regression-agent]]) RE-RUNS the investigation **once** with a JSON-only repair hint appended to the prompt ([[../specs/ada-director-spec-status-cards-fix-tooling-fa6848]] Phase 1 — naming the recognized vocabulary and reminding the agent that `"needs-human"` is always a valid safe terminal verdict), then fail-safes to an **actionable** `needs_attention` reason — `"security review produced no parseable verdict after 2 attempts — re-run or review manually: <excerpt>"` — **never** a bare "ended without a recognizable verdict", never an auto-pass. The shared `extractJson` ranks LAST-balanced-JSON last-wins so prose-around-envelope no longer breaks parsing on attempt 1. The director's `reconcileNeedsAttention` ([[platform-director]] Phase 1) then triages that parked item.

## Why npm audit runs on the box, not in the cron

`npm audit` needs the npm CLI + the committed lockfile + registry access — none reliably present in the Vercel/Inngest serverless runtime. So [[../inngest/security-dep-watch]] is the SCHEDULER (deduped, heartbeat) and the box (which has the full repo + npm) runs the actual scan. The observable behaviour matches the spec: a daily watch → an upgrade-fix spec + Build card on a finding, a healthy beat on a clean tree.

## Related

[[../specs/security-dependency-agent]] · [[../inngest/security-dep-watch]] · [[repair-agent]] · [[regression-agent]] · [[approval-router]] · [[agent-jobs]] · [[director-activity]] · [[../tables/director_activity]] · [[control-tower]] · [[../integrations/github-webhook]] · [[agent-personas]] · [[../goals/grow-surface-platform-agent-team]]
