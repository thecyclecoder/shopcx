# libraries/security-agent

The queue plumbing + autonomy policy behind the **Security / Dependency Agent** box worker ([[../specs/security-dependency-agent]]) — a worker the [[../specs/platform-director-agent|Platform/DevOps Director]] supervises. Persona: **Vault — Security Guardian** (🔒, [[agent-personas]]). It is **the supervisor on the auto-merge proxy**: auto-merge optimizes "ship the fix"; its degenerate state is shipping a fix that introduces an injection / secret-leak / authz hole. Vault gives **every merged diff an autonomous security pass** and **watches dependencies for CVEs** — review read-only + author/surface a fix, **never auto-mutate**.

**File:** `src/lib/security-agent.ts` · the box runner is `scripts/builder-worker.ts` `runSecurityReviewJob` (see [[../recipes/build-box-setup]]).

## North star — review + escalate; the owner-gated build disposes

The agent **reviews + classifies** (a bounded proxy: "did this diff/dep introduce a vulnerability + here's the fix"); the **owner-gated build applies any fix** and is graded on whether it held ([[../operational-rules]] § North star). It NEVER edits product code, opens its own PR, or bumps a dependency. Mirrors [[repair-agent]] / [[regression-agent]]: diagnose + author/surface, the disposer builds. Ambiguity escalates (`needs-human`). Every detect/escalate/author writes a [[../tables/director_activity|director_activity]] row (`director_function: 'platform'`). **Secret findings are referenced by location, never echoed in plaintext** into logs / `director_activity` / the surfaced spec.

## Three modes (one lane, `agent_jobs.kind='security-review'`)

- **`diff`** (post-merge) — a **per-merged-diff** security pass. Reviews the merged `claude/*` commit for injection, secret/credential leak, authz / RLS-policy regressions, unsafe `createAdminClient()` exposure, and `_encrypted` handling (the [[../specs/security-dependency-agent]] / `/security-review` checklist + CLAUDE.md invariants).
- **`branch`** (pre-merge — [[../specs/security-test-on-preview-pre-merge]] Phase 1) — the **per-branch** security pass that runs WHILE the build is still unmerged. Same checks as `diff`, but the box reads the UNMERGED diff (`git diff main...claude/<branch>`) and any runtime probe lands on the **per-build Vercel preview origin** (from [[per-build-vercel-preview-deploys]]), not prod. The surfaced verdict is what the **M4 promote gate** reads to refuse to auto-merge an unreviewed branch.
- **`dep-watch`** — the daily **`npm audit`** CVE scan (enqueued by [[../inngest/security-dep-watch]]). On a vulnerable dep it authors a scoped upgrade-fix spec + surfaces a Build card — never auto-bumps.

## Exports

- `type SecurityVerdict = "real-vuln" | "needs-human" | "false-positive"` — the box's per-diff classification (`clean` is a no-action terminal alongside `false-positive`).
- `SECURITY_DIRECTOR_FUNCTION = "platform"` — the function whose objective supervises this worker.
- `SECURITY_DEP_UPGRADE_SLUG = "security-dep-upgrades"` — the stable slug of the dep-upgrade fix spec (find-or-update, never N of them).
- `SECURITY_DEP_WATCH_SLUG = "security-dep-watch"` — the sentinel `spec_slug` a dep-watch scan job carries (so it dedups distinctly from per-diff jobs).
- `SECURITY_RECENT_FIX_WINDOW_MS` (24h) — a fix authored within this window is "pending deploy"; don't re-scan/re-surface.
- `LIVE_SECURITY_STATUSES` — the statuses that mean a security-review job is still live (working or surfaced).
- `securitySha12(mergeSha)` / `depFindingSignature(findings)` — the per-diff dedup key (the merge SHA) and the advisory-set signature (sorted `pkg@severity`, sha1).
- `enqueueSecurityReviewJob(admin, input)` → enqueue ONE `security-review` [[agent_jobs]] job. **Best-effort, never throws.** Two input shapes (one function — discriminated by the presence of `branch`):
  - **post-merge `diff`** `{ mergeSha, specSlug, prNumber?, workspaceId? }` — **deduped by the merge SHA** so a re-run (the two merge-hook paths firing for one merge) never double-files.
  - **pre-merge `branch`** `{ branch, previewOrigin, specSlug, prNumber?, workspaceId? }` ([[../specs/security-test-on-preview-pre-merge]] Phase 1) — **deduped to ONE OPEN review per branch** (any live/surfaced security-review job with `spec_branch === branch`). A terminal `completed`/`failed` for the branch never blocks a re-review on a later push — the new diff might re-introduce something the prior pass cleared. The `securitySha12`/`depFindingSignature` signatures still converge same-finding recurrences inside the box's review of the branch's diff.
- `enqueueDepWatchJob(admin, { workspaceId? })` → enqueue the daily dep-watch scan. Deduped to ≤1 live scan + a recent-window guard. **Best-effort, never throws.**
- `getOpenSecurityReviews(admin, workspaceId)` → `SecuritySurfaceItem[]` — READ-ONLY: open security items awaiting the owner (`needs_approval` = a routed fix with a `security_build` Build action, or `needs_attention` = needs-human). Clean reviews complete silently.
- `getSecurityStateBySlug(admin, workspaceId)` → `Record<slug, SecurityStateBySlug>` — READ-ONLY per-spec rollup (`live`/`surfaced`/`completedClean`) for the build-card lifecycle timeline's Security node + the fold gate (they MUST agree). Dep-watch sentinels excluded.
- `listSecurityReviews(admin, workspaceId, limit?)` → `SecurityReviewLogItem[]` — READ-ONLY: Vault's **full** review log (clean ones included), newest-first, for the [[../dashboard/security-tests]] surface. Derives a `verdict` per row (`clean｜false-positive｜real-vuln｜needs-human｜running｜failed` — a completed review's verdict is parsed off the `log_tail` prefix) and resolves each reviewed slug's [[../tables/specs|spec]] title. Bounded (≤500).
- `countOpenSecurityReviews(admin, workspaceId)` → `number` — the surfaced count (`needs_approval`/`needs_attention`) for the Security tests sidebar badge. Clean reviews never count.

## Trigger — event-driven (`diff` + `branch`) + a daily cron (`dep-watch`)

- **`diff`** rides the **merge hook**: [[agent-jobs]] `applyMergedBuildEffects` (the shared body of BOTH `reconcileMergedJobs` — a manual squash-merge — and `handleAutoMergedBuildBranch` — the auto-merge webhook) calls `enqueueSecurityReviewJob` with the merge SHA. So every merged `claude/*` build diff gets exactly one review, deduped by SHA.
- **`branch`** rides the **preview-ready hook** ([[per-build-vercel-preview-deploys]]): when a `claude/*` build's per-build Vercel preview reaches READY and the branch is still unmerged, the hook calls `enqueueSecurityReviewJob` with `{branch, previewOrigin}`. One open review per branch — a re-deploy of the same branch (open review still live) is a no-op.
- **`dep-watch`** is the [[../inngest/security-dep-watch]] daily cron → `enqueueDepWatchJob`.

## The box loop — `runSecurityReviewJob`

1. **Disposer resume** — a routed `security_build` action approved (queue the build) / declined (dismiss).
2. **`dep-watch` mode** — run `npm audit --json` on the real tree; collect ≥ moderate advisories; on a finding author/refresh `security-dep-upgrades` to main + route; clean tree → complete silently with a healthy beat.
3. **`diff` mode** (post-merge) — `git fetch origin main` + `git show {sha}` read-only on Max → ONE verdict (see VERDICT TAIL below).
4. **`branch` mode** (pre-merge — [[../specs/security-test-on-preview-pre-merge]] Phase 2) — `git fetch origin main` + `git fetch origin {branch}` + `git diff origin/main...origin/{branch}` read-only on Max; any runtime probe targets the per-build `preview_origin` from [[per-build-vercel-preview-deploys]], **NOT prod**. Same review checks + verdict envelope as `diff` mode (the prompt shares one `securityReviewChecksAndVerdictBlock`), so Vault's contract is identical regardless of when she runs. On `real-vuln` the authored fix spec records `Fixes: [[parent-slug]]` + `**Security-of-branch:** \`{branch}\` · preview \`{previewOrigin}\`` (vs `**Security-of-merge:**` for `diff`) so a glance shows which mode caught it. The terminal state (`completed` clean / `needs_approval` routed-fix / `needs_attention` needs-human / `failed`) is what the **M4 promote gate** reads to refuse to auto-merge an unreviewed branch (Phase 3's `completedClean` signal).

**VERDICT TAIL** (shared between `diff` + `branch`):
   - `clean` / `false-positive` → complete, no action.
   - `needs-human` → `needs_attention` + an `escalated` activity row, no spec. The activity reason cites the mode-appropriate context (`merged {slug} (commit {sha})` for diff · `unmerged {slug} (branch {branch})` for branch).
   - `real-vuln` → **author the fix spec to main** (`authorSecurityFixSpec(..., source)` where `source = {kind:'diff', mergeSha}` or `{kind:'branch', branch, previewOrigin}`; `Fixes: [[parent-slug]]`), then `routeSecurityFix` via `resolveApproverLive('platform')` ([[approval-router]]): a live+autonomous director auto-queues the build within its leash; else surface a `security_build` Build card for the **CEO inbox** (the generic [[../specs/approval-routing-engine|approval-inbox]] reconciler emits the routed request — no per-agent route needed). Records `authored_fix`.
   - **Unparseable/unrecognized verdict** ([[../specs/needs-attention-triage-and-verdict-robustness]] Phase 2 + [[../specs/iteration-ingest-async-reports-fix-tooling-69594a]] + [[../specs/ada-director-spec-status-cards-fix-tooling-fa6848]]) → the shared `resolveReviewVerdict` helper (shared with [[repair-agent]] + [[regression-agent]]) first attempts a **same-session JSON parse-repair re-prompt** (`securityReviewRepairPrompt`) — the model already spent the budget doing real review work, so re-emitting ONLY the verdict envelope from the existing context recovers a verdict far cheaper + far more often than a fresh re-investigation. Two tooling guards underneath the repair (added when fa6848a7 parked despite the parse-repair already shipping): (a) `shAsync` closes stdin (`stdio: ["ignore", …]`) so the claude CLI doesn't burn 3s on its "no stdin data received" warning (the CLI's own recommended `< /dev/null` fix, in-process) — that warning was visible on every parked tooling_failure (fa6848a7, 69594acf); (b) `extractJson` now walks every fenced ```` ```json ```` block (last-wins) and scans the LAST balanced `{…}` (right-to-left close × left-to-right open), so a verdict envelope buried under prose-braces or an earlier example JSON parses correctly. If the parse-repair still fails (or no prior session exists), it fail-safes to an **actionable** `needs_attention` reason — `"security review produced no parseable verdict after 2 attempts — re-run or review manually: <excerpt>"` — **never** a bare "ended without a recognizable verdict", never an auto-pass. The director's `reconcileNeedsAttention` ([[platform-director]] Phase 1) then triages that parked item.

## Why npm audit runs on the box, not in the cron

`npm audit` needs the npm CLI + the committed lockfile + registry access — none reliably present in the Vercel/Inngest serverless runtime. So [[../inngest/security-dep-watch]] is the SCHEDULER (deduped, heartbeat) and the box (which has the full repo + npm) runs the actual scan. The observable behaviour matches the spec: a daily watch → an upgrade-fix spec + Build card on a finding, a healthy beat on a clean tree.

## Related

[[../specs/security-dependency-agent]] · [[../inngest/security-dep-watch]] · [[../dashboard/security-tests]] · [[repair-agent]] · [[regression-agent]] · [[approval-router]] · [[agent-jobs]] · [[director-activity]] · [[../tables/director_activity]] · [[control-tower]] · [[../integrations/github-webhook]] · [[agent-personas]] · [[../goals/grow-surface-platform-agent-team]]
