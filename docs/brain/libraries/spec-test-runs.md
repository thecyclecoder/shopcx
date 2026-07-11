# libraries/spec-test-runs

Server-side helpers + shared types for the box **spec-test** QA agent's report over shipped-but-unverified
specs. The daily [[../inngest/spec-test-cron]] enqueues a `kind='spec-test'` [[../tables/agent_jobs]] row per
shipped-but-not-archived spec; the box worker (`runSpecTestJob`) runs the `spec-test` skill and writes one
[[../tables/spec_test_runs]] row. This module is the read/normalize/derive layer those rows surface through —
the [[../dashboard/roadmap|Developer → Spec Tests]] page, the roadmap board chip + Agent-tested stamp, the
spec-detail `VerificationCard`, and the Human-test queue. Part of the [[../specs/spec-test-agent|spec-test agent]]
family alongside [[spec-green-writeback]].

**File:** `src/lib/spec-test-runs.ts`

The agent **never** marks a spec verified/archived and **never** runs a mutating check — it stamps an
`agent_verdict` (a bounded "the automatable checks pass" proxy, the supervisable-autonomy north star in
[[../operational-rules]]) that the owner then confirms.

## Types

- `CheckVerdict` = `pass | fail | needs_human | inconclusive` — per-bullet outcome.
- `CheckCategory` = `auto | needs_human | inconclusive` — how the bullet was classified.
- `AgentVerdict` = `approved | issues | needs_human | error` — the run-level stamp. `issues` iff any check is an
  evidence-backed `fail`; `error` is the no-parseable-output terminal state (never a silent 0-check `approved`).
- `SpecTestCheck` `{ text, verdict, category?, evidence, screenshot? }` · `SpecTestSummary`
  `{ auto_pass, auto_fail, needs_human, inconclusive }` · `SpecTestRun` (one normalized row).
- `VerificationBullet` · `GreenBullet` · `HumanCheckRow` · `HumanQueueItem` · `RegressionItem` · `HumanTestQueue`.

## Exports

### Runs — read + normalize
- `normalizeRun(row)` → `SpecTestRun` — coerce a raw DB row (summary always re-derived from `checks[]`, so an
  empty `checks[]` can never read as a clean pass).
- `getLatestSpecTestRuns(workspaceId)` → `Record<slug, SpecTestRun>` — latest run per spec (the board/page read).
- `getPreMergeErrorRuns(workspaceId)` → `SpecTestRun[]` — the latest per-`(slug, spec_branch)` row whose
  `agent_verdict='error'`; drives the **Pre-merge / errored** surface on `/dashboard/developer/spec-tests`
  ([[../specs/spectest-error-visible-and-rerunnable]] Phase 2). The shipped list filters to `status='shipped'`,
  so a PRE-MERGE (in_progress) spec's reaped-mid-run errored gate had NO UI slot — this is that read. `error`
  is a TRANSIENT (no result), never a real pass/fail; the re-run button routes through
  [[agent-jobs]] `enqueuePreMergeSpecTest` with the row's `spec_branch` + `preview_url` so the retry hits
  the per-build `*.vercel.app` preview, not prod.
- `hasActiveSpecTestJob(workspaceId, slug)` → `boolean` — in-flight dedupe for the **Test now** button.
- `chipParts(summary)` → `{ pass, fail, human, inconclusive }` — the `✅·✗·👤·?` board chip counts.

### Evidence screenshots (private bucket)
- `SPEC_TEST_EVIDENCE_BUCKET` (`"spec-test-evidence"`) · `ensureSpecTestEvidenceBucket()` ·
  `signSpecTestScreenshot(path, ttlSec=3600)` → short-TTL signed URL (never a public URL — a dashboard
  screenshot can carry real customer data). Used by the BROWSER-check evidence rendering
  ([[../specs/spec-test-deep-verification]] Phase 1).

### Check identity + green state
- `checkKey(text)` → `sha1(normalized text).slice(0,16)` — the stable bullet key that survives re-runs
  (a reworded bullet becomes a new item). The same hash [[spec-test-human-checks]] + [[spec-green-writeback]] key on.
- `parseVerificationBullets(raw)` → `VerificationBullet[]` · `GREEN_CHECK` (`✅`) ·
  `deriveGreenBullets(...)` → per-bullet green state (green iff its latest-agent check is `pass` OR the owner
  resolved it `verified`). Consumed by [[spec-green-writeback]] `reflectSpecGreenChecks` to annotate the spec markdown.

### Human-test queue (Phase 2)
- `HumanCheckResolution` = `verified | failed | dismissed` · `isHumanResolution(v)`.
- `getHumanCheckResolutions(workspaceId)` → `Map<check_key, HumanCheckRow>`.
- `upsertHumanCheckResolution({...})` / `clearHumanCheckResolution(...)` — owner-only writes to
  [[../tables/spec_test_human_checks]], integrity-checked (`check_key` must equal `checkKey(check_text)`).
- `getHumanTestQueue(workspaceId)` → `HumanTestQueue` — aggregates every waiting `needs_human` check across the
  latest run of each shipped-unfolded spec (drives the **advisory** Human QA queue — these never gate the fold; task #29)
  **+ the Regressions list** (keyed off evidence-backed `fail` checks only — `needs_human`/`inconclusive` never appear
  there, [[../specs/spec-test-classification|the classification rule]]). Regressions DO block the fold.

### Pre-merge mode — `claude/*` branch verification against the per-build preview ([[../specs/archive.d/spec-test-on-preview-pre-merge]])
The spec-test agent runs in TWO modes off the SAME runner + JSON contract:
- **Post-ship (standing lane)** — the daily [[../inngest/spec-test-cron]] sweep + the on-demand **Test now** button enqueue
  one `kind='spec-test'` job per shipped-but-not-archived spec; the runner's checks hit **prod** (`https://shopcx.ai`). Both
  `spec_branch` and `preview_url` on the resulting `spec_test_runs` row are NULL — the latest-per-`(workspace, slug)` read
  ([[#runs-read--normalize|getLatestSpecTestRuns]]) drives the board chip + Auto-fold gate.
- **Pre-merge** (Phase 1 enqueue: [[../libraries/agent-jobs]] `enqueuePreMergeSpecTest`; Phase 2 runner: `scripts/builder-worker.ts`
  → `runSpecTestJob`) — when a `claude/*` build reaches a READY per-build Vercel preview ([[../specs/per-build-vercel-preview-deploys]]
  Phase 2 stamps `agent_jobs.preview_url`) and the branch is still unmerged, the worker enqueues ONE `kind='spec-test'` job stamped
  with `spec_branch=<branch>` + the preview origin in `instructions`. The runner threads that origin onto every non-destructive
  probe — `curl`/HTTP GETs, `vercel inspect|logs <preview>`, `npx tsx scripts/spec-test-browser-check.ts --base-url <preview>` —
  so the WHOLE verification hits the per-build `*.vercel.app` preview, NEVER prod. The resulting `spec_test_runs` row carries
  `spec_branch` + `preview_url` (the per-branch index `spec_test_runs_ws_slug_branch_idx` backs the per-`(slug, branch)` read).
  The runner's contract is otherwise unchanged: one JSON verdict, no mutating checks. Dedupe key is per-branch (workspace, slug,
  branch) so a pre-merge run on branch A doesn't block one on branch B; the post-ship `(workspace, slug)` chokepoint is strictly
  broader so the two lanes never collide.
  **Fused pre-merge security review ([[../specs/consolidate-premerge-checks-one-session]] Phase 1).** The pre-merge session ALSO
  emits a SECURITY REVIEW off the same branch diff it already loaded — a two-verdict JSON envelope
  (`{...spec_test, security: {...}}`). The worker writes the spec-test verdict to `spec_test_runs` FIRST (partial-safety — a session
  that dies after the spec-test half still records it), then INSERTS a synthetic `security-review` `agent_jobs` row for the branch
  (mode='branch', status='claimed' so the standalone poll never picks it) and applies the security verdict via the shared
  `applySecurityVerdictToJob` sink — SAME appliers the standalone lane uses (`director_activity` + [[security-agent]] fix-spec author
  + [[approval-router]] fix-routing). The standalone `security-review` branch-mode enqueue ([[agent-jobs]]
  `maybeEnqueuePreMergeSecurityOnAccumulation`) is now inert (its work moved into this fused session); the standalone lane still
  runs for post-merge `diff` mode + on-demand use, and it's the safety-net fallback the fused session invokes when its own security
  envelope is missing/malformed. The M4 promote gate's dual green signal (`isSpecTestGreenForBranch` ∧ `isSecurityGreenForBranch`)
  reads the same rows — the synthetic security-review row satisfies the security signal.

### Pre-merge green-signal (Phase 3) — readable by the M4 promote gate
- `getLatestSpecTestRunForBranch(workspaceId, slug, branch)` → `SpecTestRun | null` — the latest pre-merge row for the branch
  (per-branch index read; null = no pre-merge run landed yet → defer, NOT green).
- `getSpecTestStateForBranch(workspaceId, slug, branch)` → `{ latest, cleanMachinePass }` — the per-branch rollup the
  **M4 pre-merge promote gate** reads. **Calls the SINGLE shared `isCleanMachinePassRun` predicate** that
  [[#auto-fold-gate--gate-b-fold-on-machine-spec-test-pass--security-clear-fold-on-spec-test-pass-task-29-specsbuild-card-lifecycle-timeline-phase-3|getAutoFoldEligibleSlugs]] Rail 2 also calls (not a copy — the helper IS the rule), so the pre-merge gate and the post-ship fold gate can never disagree on what "spec-test green" means.
- `isCleanMachinePassRun(run, resolutions, slug)` → `boolean` — **THE clean-machine-pass predicate, shared by both gates.** A run is clean iff: (a) agent-verdict `approved` OR `needs_human` (task #29: `needs_human` is advisory-eligible; `issues`/`error`/missing are non-pass); (b) **the run ASSERTED ≥1 check (`run.checks.length >= 1`)** — the **`total_checks >= 1` floor that REPLACED the old `auto_pass >= 1` floor**: it still rejects a degenerate 0-check / `error` "silent empty pass" (nothing asserted), but a **HUMAN-ONLY spec** whose Verification is entirely `needs_human` checks (`auto_pass=0`) now passes the floor instead of sitting `in_testing` forever — **CEO decision: human checks are FULLY ADVISORY, a human-only run promotes on 0 auto-fails WITHOUT resolving the human checks**; (c) 0 UNRESOLVED auto-`fail` regressions (joins the same `spec_test_human_checks` resolutions the human-queue uses — a `verified`/`dismissed` resolution clears it; `needs_human` checks never gate).
- `isSpecTestGreenForBranch(workspaceId, slug, branch)` → `boolean` — convenience boolean (`cleanMachinePass`). Mirrors
  [[security-agent]] `isSecurityGreenForBranch` so M4 reads both signals with one call pattern.
- **Absence of a run is NOT green** — defer (the pre-merge enqueue hasn't fired yet, or the box hasn't reached a verdict);
  same absence-≠-clean rule the post-ship fold gate applies.
- **Human-only-promote advisory (sub-task 1b; CEO "ideally Ada looks at it").** When a **ZERO-machine-coverage** spec
  (`summary.auto_pass === 0` — a human-only Verification) PROMOTES at the M4 auto-merge point ([[github-pr-resolve]]
  `resolveOpenSpecPrs`, right after the squash-merge), the promote path surfaces a **lightweight, NON-BLOCKING** advisory via
  [[director-activity]] `recordHumanOnlyPromoteAdvisory(admin, ws, slug)` — one `human_only_promote_advisory` `director_activity`
  row ("shipped with no machine coverage — eyeball the human checks") for the Platform/DevOps Director (Ada). It **NEVER gates
  the promotion**, builds **no approval card**, and is **idempotent** (one row per spec). The `zeroMachineCoverage` flag is read
  off the SAME `getSpecTestStateForBranch` the gate already evaluated (no extra query).

### Auto-fold gate — Gate B (fold on MACHINE spec-test pass + SECURITY clear; fold-on-spec-test-pass, task #29; [[../specs/build-card-lifecycle-timeline]] Phase 3)
**The fold trigger is the MACHINE spec-test pass + a clean post-merge SECURITY review, NOT human verification.** Fold is
non-destructive (the [[../tables/specs]] row is preserved with `status='folded'`; the fold just extracts knowledge into the
permanent brain pages), so the spec-test agent's green grade over the `## Verification` bullets + a clean security pass are
sufficient to fold. **Human QA is advisory** — a `needs_human` *verdict*, a waiting/failed `needs_human` *check*, or a human
`failed` resolution NEVER blocks the fold (task #29).
- `getAutoFoldEligibleSlugs(workspaceId)` → `string[]` — the shipped-not-archived specs whose **machine spec-test passed AND
  security cleared**:
  - **Spec-test gate (the shared `isCleanMachinePassRun` predicate — same helper the pre-merge gate calls):** latest run a
    **clean machine pass** (agent-verdict `approved` **OR `needs_human`**) **with `run.checks.length >= 1`** (the run ASSERTED
    at least one check) · 0 **unresolved auto-`fail` regressions**.
    **`total_checks >= 1` REPLACED the old `auto_pass >= 1` floor (spec-test-human-only-promote-gate):** the old floor's only
    real job was to reject a degenerate 0-check / `error` "silent empty pass", but it ALSO permanently stranded a **HUMAN-ONLY
    spec** whose Verification is entirely `needs_human` checks (`auto_pass=0`, e.g. `devops-kpi-weekly-snapshot-date-lag-fix`
    `pass:0 fail:0 human:1`) — it sat `in_testing` forever. **CEO decision: human checks are FULLY ADVISORY — a human-only run
    (≥1 check, 0 auto-fails, verdict `needs_human`) promotes WITHOUT requiring the human checks to be resolved.** `checks.length
    >= 1` preserves the no-empty-run / no-`error`-row guard (all the floor really protected) while letting the human-only run
    through.
    **`needs_human` is ADVISORY-ELIGIBLE (task #29):** a `needs_human` verdict means the agent machine-verified everything it
    could and flagged the REMAINDER for *optional* human review — it is NOT a failure. It does
    **NOT** consult `needs_human` *checks* or human `failed` resolutions (those are advisory). A genuinely failing run
    (`issues`/`error`, a **0-check degenerate row**, or an open auto-`fail` — including a `needs_human` run whose checks
    include an UNRESOLVED machine `fail`) is NOT eligible — it surfaces the failure instead. It grades `getRoadmap(workspaceId)`
    (the SAME tenant whose runs it reads), not the default-resolved workspace.
    > **Three copies stay in sync via the one helper.** `getSpecTestStateForBranch` (pre-merge promote), `getAutoFoldEligibleSlugs`
    > Rail 2 (post-ship fold), and the board's `in_testing` overlay (`brain-roadmap.ts` `readInTestingSignals`) ALL call
    > `isCleanMachinePassRun`. The overlay matters: `applyInTestingOverlay` forces `in_testing` (overriding `shipped`) unless the
    > spec-test is green — so if the overlay disagreed, a merged human-only spec would be downgraded out of `shipped` and the fold
    > gate's `s.status === "shipped"` check would re-strand it. One predicate ⇒ they can never disagree.
  - **Security-test gate (Phase 3):** the per-diff [[security-agent]] review for the slug must be `completedClean` via
    [[security-agent]] `getSecurityStateBySlug` (a `completed` job exists AND no live `queued`/`claimed`/`building`/
    `needs_input`/`queued_resume` job AND no surfaced `needs_approval` routed fix / `needs_attention` needs-human finding).
    Same signal Phase 1's `securityCompletedClean` reads, so the [[build-lifecycle]] Security node and this gate **can never
    disagree**. A spec with a live or surfaced security-review **defers** the fold (hitting the rail = escalate, never fold past
    it); a shipped spec missing a security-review record entirely also defers (the post-merge enqueue hasn't fired yet).
  - **fold-guard-live-build:** a slug with a live `build`/`spec-test` `agent_jobs` row (status in `ACTIVE_STATUSES`) is **also
    excluded** — auto-folding it would orphan the running build (its spec page 404s the moment the fold merges), so the fold is
    deferred until the job is terminal (the next gate pass re-picks it up), never dropped. This mirrors the manual fold guard
    `getLiveJobForSlug` ([[agent-jobs]]).
- `isAutoFoldEnabled(workspaceId, admin?)` → `boolean` — the owner kill-switch (`workspaces.auto_fold_enabled`,
  default ON; `select("*")` so a pre-migration deploy degrades to enabled). Mirrors `isAutoMergeEnabled`.
- `autoFoldVerifiedSpecs(workspaceId, admin?)` → `AutoFoldResult` — for each eligible spec not already
  `pending`/`folding`, calls `enqueue_fold(p_user:null)` (coalesced into the ONE batch fold-build, [[../specs/fold-build-batching]]);
  emits the `auto-fold-gate` reactive Control Tower heartbeat ([[control-tower]], `AUTO_FOLD_GATE_LOOP_ID`). The
  machine-pass mirror of `autoMergeReadyPrs` ([[github-pr-resolve]]), one rung up the pipeline. Triggered reactively by
  the worker after a spec-test run (the primary fold trigger), as a best-effort backstop by the advisory human-queue POST,
  and periodically by [[../inngest/spec-test-cron]].
- `reactiveFoldOnGateComplete(workspaceId, slug, opts?)` → `AutoFoldResult | null` — the **EVENT-DRIVEN primary trigger**
  for Gate B (reactive-fold). Call it at every completion that can flip THIS spec's fold-eligibility — the LAST gate to
  clear: the **post-merge SECURITY review clean** (`runSecurityReviewJob` `diff`-mode, the usual last gate for a one-off:
  PR merges → phases ship → post-merge security clears → eligible), and the **post-merge phase-ship advance**
  (`applyMergedBuildEffects` / `reconcileMergedSpecPhases` in [[agent-jobs]], for a spec whose spec-test + security already
  cleared). Re-checks `slug`'s eligibility via the canonical `getAutoFoldEligibleSlugs` (one source of truth — the reactive
  trigger + the cron backstop can never disagree); if eligible, enqueues through the SAME path the cron uses
  (`autoFoldVerifiedSpecs` → `enqueue_fold`). **Idempotent** (no-ops when the spec isn't eligible yet; `autoFoldVerifiedSpecs`
  skips a spec a fold job already owns + `enqueue_fold` advisory-locks per workspace) + best-effort (swallows throws — the
  cron backstop still mops up). This is the SAME reactive-primary + cron-backstop pattern on Gate-A merge, the pre-merge legs,
  and the phase chain. The spec-test-completion auto-fold (`runSpecTestJob`) is the third trigger and already fires its own
  `autoFoldVerifiedSpecs`. See [[../lifecycles/roadmap-build-console]] § reactive-fold.

## Classification policy — "if a machine can test it, the machine does it"

The `CheckCategory` a bullet lands in is decided by a policy that biases hard toward non-destructive
verification (the founder's mandate: human testing is reserved for genuine visual/aesthetic judgment, not
migration-presence probes or fault-injection). It lives in the `spec-test` skill (Step 1) + the inline
classification prompt in `runSpecTestJob` (`scripts/builder-worker.ts`); this is its brain home.

- **`auto` spans three non-destructive modes.** (1) **Read-only probe** — `information_schema` / probe-db
  SELECT, GET endpoint, repo `grep`/`tsc`, CI/deploy status. (2) **Outcome probe** — for a *"do X (mutation)
  → expect observable Y"* bullet, verify **Y read-only** if it's already observable in prod from real traffic
  (a row in the expected state, a populated column, a rendered context string); do NOT defer just because X
  mutates. (3) **Non-destructive local harness** — author a throwaway `_`-prefixed scratch `npx tsx` script
  that imports a pure function/parser/classifier from `src/` and exercises it, **including fault injection**
  (malformed payload, forced parse error), entirely locally with no prod write or network side-effect; record
  the harness output as evidence. A local-harness check that observes breakage is a legitimate `fail`.
- **`needs_human` is narrowed to exactly two cases:** (a) genuine **visual/aesthetic** judgment (looks good /
  big enough / renders nicely), and (b) an **irreversible prod side-effect with no already-observable evidence
  AND no local-harness equivalent** (e.g. a real SMS/email/charge actually reaching an external carrier).
- **Tie-breaker:** *not* "when in doubt → needs_human" — instead **attempt a read-only outcome probe, then a
  non-destructive local harness; defer to `needs_human` ONLY if both are impossible.**
- **Invariant kept:** the agent still never writes prod, never sends a message/charge/order, never flips a spec
  to verified. "Maximize machine coverage" means *more non-destructive verification*, never relaxing the
  prod-write ban. The richer browser + sandboxed behavioral modes layered on top live in
  [[spec-test-sandbox]] ([[../specs/spec-test-deep-verification]]).

## Harness/command failure is never a code `fail` (vera-harness-error-is-not-a-code-regression)

**Invariant** — a verification bullet whose named command does not exist / cannot run in the repo is a
**verification-authoring problem**, never a code regression, and MUST NEVER spawn a Bo fix phase.

**Why the invariant exists.** On 2026-07-11 the shipped spec `cs-director-leash-categories` carried a
verification bullet naming `npm test src/lib/agents/cs-director.test.ts`. This repo has no `npm test`
script (only named scripts like `npm run test:cs-director`). Vera ran the literal command, `npm error
Missing script: "test"` exited 1, and Vera recorded `verdict='fail'`. That mis-classified `fail`
spawned an inline "fix" phase asking Bo to resolve 2 pre-merge spec-test regressions — but nothing in
the CODE was broken, so Bo could not build the phase and the whole accumulation wedged.

**Harness/command signatures** — the classifier ([[../../../src/lib/spec-test-harness-classifier.ts]]
`isHarnessCommandFailure`) recognises any of these as the command NEVER having run an assertion:
`npm error Missing script`, `command not found`, `: not found`, `No such file or directory` / `ENOENT`,
`Cannot find module` / `Cannot find package`, `Missing script:`, `Unknown command:`. Case-insensitive.

**Two-layer defence.** Both layers use the SAME predicate so they can never disagree:

1. **Vera-side classify + resolve** — the `spec-test` skill (`.claude/skills/spec-test/SKILL.md` §
   *Harness/command failure*) + the `runSpecTestJob` prompt teach Vera to grep `package.json`
   `"scripts"` for a matching `test:<name>` and re-run the resolved script when possible; a resolved
   assertion pass is `pass`, a resolved assertion fail is a real `fail`; if no runnable script maps,
   the check is `needs_human` (a verification-authoring wart), NEVER `fail`.
2. **Worker-side reclassifier** — `normalizeSpecTest` in `scripts/builder-worker.ts` runs
   `reclassifyHarnessFails` on the checks array BEFORE deriving `summary` / `agent_verdict`, so a
   slipped harness `fail` is downgraded to `needs_human` (with the original stderr preserved as
   evidence) before it can land in `spec_test_runs.auto_fail`, flip the verdict to `issues`, or reach
   any fix-phase authoring path.

**Fix-phase authoring guard (Phase 2 belt-and-suspenders).** Both authoring paths ALSO filter harness
checks at their own gate, so a legacy `spec_test_runs` row / a concurrent race can never squeak past:

- `src/app/api/roadmap/spec-test/request-fix/route.ts` — the inline "Request a fix" POST filters
  `allFails.filter(!isHarnessCommandFailure)`; a run whose failing checks are ALL harness-class
  returns HTTP 400 with `harnessFails: [...]` (the owner sees the verification-authoring wart to fix
  on the origin spec — no Bo fix phase is authored).
- `src/lib/pre-merge-fix.ts` `spawnPreMergeFix` — filters harness-class checks out of `cleanFailing`
  BEFORE any `appendFixPhases` / `recordDirectorActivity` call. If every failing check was harness,
  the function returns `{ spawned:false, escalated:false, reason: "no evidence-backed failing checks
  — nothing to fix" }` — the auto-merge tests-gate stays closed on red, but no Fix N phase gets
  appended to the origin's build chain.

**Result** — only a command that RAN and had an assertion FAIL can author a Bo fix phase. A harness /
command wart surfaces as a `needs_human` check for the owner to fix as verification authoring, never
as a fix-phase that wedges the pipeline. Tests live at
[[../../../src/lib/spec-test-harness-classifier.test.ts]] pinning the exact motivating stderr as the
downgraded state, and confirming a real assertion `fail` still flows through as `fail`.

## Durable mandate (agent-mandate-hardening-spec-test)

Two permanent rules that override any tendency to bail or auto-pass, baked into `runSpecTestJob` (scripts/builder-worker.ts):

- **Fresh sessions are the normal starting state.** A spec-test session is ALWAYS stateless — "no prior verification context / no security review context available in this session" is the EXPECTED entry condition, NEVER a reason to bail with a prose response and no verdicts. When you encounter this, re-derive the spec's `## Verification` bullets from the materialized spec file (`.box/spec-<slug>.md`) yourself, classify each bullet, and **run the non-destructive checks in-session**: `npx tsc --noEmit`, `gh` CI status, read-only DB probes, GET endpoints, the browser check, the sandbox toolkit, AND the spec's own read-only harness (e.g., `npx tsx scripts/commerce-diff-sample.ts` when the spec ships one — the harness's own header declares "READ-ONLY BY CONSTRUCTION"). Emit the per-check `agent_verdict` JSON. Refusing to fabricate a false-✅ is correct; the fix is to actually run the checks.

- **Runtime-behavior bullets are never auto-pass off static signals.** When a bullet asserts a runtime BEHAVIOR (a failure-path surfacing on `worker_heartbeats.detail`, a post-deploy box backstop firing, an approved action executing), a ✅ off "the code that would do X exists", "a Ready preview is up", or "an unrelated healthy heartbeat" is a false positive that will be caught. Either **drive the exact named state** — trigger the failure branch (sandbox or forced-fault harness), run a sandbox behavioral invocation, or defer a live-DB outcome to a post-deploy read-only probe — and put that observed state in the evidence field, **OR classify the bullet `needs_human`** with a note. Never conflate "code exists" with "behavior happened".

## Callers

- `scripts/builder-worker.ts` → `runSpecTestJob` — writes runs; calls `reflectSpecGreenChecks` then `autoFoldVerifiedSpecs` after.
- `scripts/builder-worker.ts` → `runSecurityReviewJob` — on a `diff`-mode `clean`/`false-positive` completion (the post-merge last gate), calls `reactiveFoldOnGateComplete` (reactive Gate B).
- `src/lib/agent-jobs.ts` → `applyMergedBuildEffects` + `reconcileMergedSpecPhases` — on a post-merge shipped rollup / back-fill, calls `reactiveFoldOnGateComplete` (reactive Gate B).
- `src/app/dashboard/developer/spec-tests/**` + `VerificationCard` + the roadmap board cards — read via `getLatestSpecTestRuns` / `getHumanTestQueue` / `signSpecTestScreenshot`.
- `src/app/api/developer/spec-test/human-queue/route.ts` — `getHumanTestQueue` (GET) + the upsert/clear helpers (POST, owner-only); POST also fires `autoFoldVerifiedSpecs` (Gate B).
- `src/lib/inngest/spec-test-cron.ts` — daily periodic backstop sweep calling `autoFoldVerifiedSpecs` per workspace.
- `src/lib/spec-drift.ts` — uses `checkKey` to match a fix spec's `**Fixes:**` check hashes.

## Gotchas

- **Summary always derives from `checks[]`** (`normalizeRun`) — an empty/uncertain run can never read as `approved`.
- **`checkKey` whitespace-normalizes** — the agent's `check.text` and the spec bullet must match for a `pass` to
  land green or a human resolution to stick (the shared assumption across green-writeback + the human queue).
- Screenshot paths are **private-bucket storage paths**, never public URLs — always sign per-render.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/spec_test_runs]] · [[../tables/spec_test_human_checks]] · [[spec-green-writeback]] · [[../dashboard/roadmap]] · [[../lifecycles/roadmap-build-console]]
