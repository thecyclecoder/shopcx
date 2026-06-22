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

## Callers

- `scripts/builder-worker.ts` → `runSpecTestJob` — writes runs; calls `reflectSpecGreenChecks` after.
- `src/app/dashboard/developer/spec-tests/**` + `VerificationCard` + the roadmap board cards — read via `getLatestSpecTestRuns` / `getHumanTestQueue` / `signSpecTestScreenshot`.
- `src/app/api/developer/spec-test/human-queue/route.ts` — `getHumanTestQueue` (GET) + the upsert/clear helpers (POST, owner-only).
- `src/lib/spec-drift.ts` — uses `checkKey` to match a fix spec's `**Fixes:**` check hashes.

## Gotchas

- **Summary always derives from `checks[]`** (`normalizeRun`) — an empty/uncertain run can never read as `approved`.
- **`checkKey` whitespace-normalizes** — the agent's `check.text` and the spec bullet must match for a `pass` to
  land green or a human resolution to stick (the shared assumption across green-writeback + the human queue).
- Screenshot paths are **private-bucket storage paths**, never public URLs — always sign per-render.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/spec_test_runs]] · [[../tables/spec_test_human_checks]] · [[spec-green-writeback]] · [[../dashboard/roadmap]] · [[../lifecycles/roadmap-build-console]]
