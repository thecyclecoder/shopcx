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
  latest run of each shipped-unverified spec **+ the Regressions list** (keyed off evidence-backed `fail` checks
  only — `needs_human`/`inconclusive` never appear there, [[../specs/spec-test-classification|the classification rule]]).

### Auto-fold gate — Gate B ([[../specs/auto-ship-pipeline]] Phase 2)
- `getAutoFoldEligibleSlugs(workspaceId)` → `string[]` — the **all-green** shipped-not-archived specs: latest run
  agent-verdict `approved` · 0 waiting `needs_human` checks · 0 human checks resolved `failed` · 0 unresolved
  auto-`fail` regressions. Reuses the SAME per-spec derivation as the board chip / human-test queue, so the gate
  can never disagree with what the owner sees. **fold-guard-live-build:** a slug with a live `build`/`spec-test`
  `agent_jobs` row (status in `ACTIVE_STATUSES`) is **also excluded** — auto-folding it would orphan the running build
  (its spec page 404s the moment the fold merges), so the fold is deferred until the job is terminal (the next gate
  pass re-picks it up), never dropped. This mirrors the manual verify guard `getLiveJobForSlug` ([[agent-jobs]]).
- `isAutoFoldEnabled(workspaceId, admin?)` → `boolean` — the owner kill-switch (`workspaces.auto_fold_enabled`,
  default ON; `select("*")` so a pre-migration deploy degrades to enabled). Mirrors `isAutoMergeEnabled`.
- `autoFoldVerifiedSpecs(workspaceId, admin?)` → `AutoFoldResult` — for each eligible spec not already
  `pending`/`folding`, calls `enqueue_fold(p_user:null)` (coalesced into the ONE batch fold-build, [[../specs/fold-build-batching]]);
  emits the `auto-fold-gate` reactive Control Tower heartbeat ([[control-tower]], `AUTO_FOLD_GATE_LOOP_ID`). The
  all-green mirror of `autoMergeReadyPrs` ([[github-pr-resolve]]), one rung up the pipeline. Triggered reactively by
  the worker after a spec-test run + by the human-queue POST, and periodically by [[../inngest/spec-test-cron]].

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

## Callers

- `scripts/builder-worker.ts` → `runSpecTestJob` — writes runs; calls `reflectSpecGreenChecks` then `autoFoldVerifiedSpecs` after.
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
