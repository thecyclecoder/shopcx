# libraries/build-lifecycle

Pure, DB-driven derivation of which of the 5 lifecycle stages a build-card / spec-card is currently on
([[../specs/build-card-lifecycle-timeline|build-card-lifecycle-timeline]] Phase 1). Drives the compact 5-node
timeline the roadmap board + Control Tower render in Phase 2 (Spec Review · Build · Spec Test · Security · Fold),
replacing the floating status pill.

**File:** `src/lib/build-lifecycle.ts`

## Why this exists

A build-card today carries ONE floating status pill (the most live signal — `building`, `needs-attention`,
`queued`…). That pill collapses five distinct lifecycle gates into one symbol: you can't tell at a glance
whether Vale's still reviewing, the build is running, the spec-test passed, the security review cleared, or
the spec is awaiting fold. This module computes the **per-stage rollup** so the card can render a check on
every completed upstream stage AND attach the live status pill to the CURRENT (earliest non-done) stage —
the pill lands where work is actually happening.

The helper is **pure + side-effect-free**: it reads only signals the board / Control Tower already loads,
does no DB I/O, and is unit-testable from a fixture (`src/lib/build-lifecycle.test.ts`, `npm run
test:build-lifecycle`). No new column is added — every stage status is **derived** from the existing data
([[brain-roadmap]] phases + per-phase `build_sha`, the spec's `vale_pass`, the latest [[spec-test-runs]]
row, the [[security-agent]] `agent_jobs` state).

## Stage order is the BRANCH-FLOW order (spec-goal-branch-pm-flow)

The pipeline builds + **tests a spec on its branch preview BEFORE promoting it to `main`**
([[../lifecycles/spec-goal-branch-pm-flow]]): **build-on-branch → spec-test (pre-merge) → security
(pre-merge) → MERGE/ship to main → fold**. So the Build node finishes when the spec is **built on its
branch** (NOT when it ships), and **Spec Test + Security are the pre-merge gates** that run while the spec
is still `in_testing` (built + being tested on a branch, not yet on `main`). The "shipped to main" event
sits between Security-done and Fold — the card's top 3-node timeline (built on branch → in testing →
shipped) shows that hop; this 5-node detail folds it into the Build/SpecTest/Security → Fold transition.

> **This replaced the old post-ship gates.** Previously Spec Test + Security were gated `status !== shipped
> → pending`, so a spec actively running its pre-merge spec-test (Build done on branch, status still
> `in_testing`/`in_progress`) rendered Build=active + Spec Test/Security greyed — the card looked like "no
> spec test happened" for the whole pre-merge window. The gates now key on the branch-flow `builtOnBranch`
> signal, not shipped status.

## Stages

The 5 stages, in order — a spec walks them left to right:

1. **`spec-review`** — **RETIRED** ([[../specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]]) · the deterministic [[../libraries/spec-review-gate]] replaces Vale at authoring time. The legacy Vale LLM stage is no longer used — a malformed spec is rejected instantly at author-time (never reaches `public.specs`), and a well-formed spec passes by construction (no `in_review` waiting-room). The stage now ALWAYS reads as `done` (specs skip `in_review` entirely and derive `planned`/`in_progress` via the phase rollup). Legacy signal for historical reference: `vale_pass` on an `in_review` spec; this status is no longer emitted on new specs.
2. **`build`** — Build agent accumulating phases on the spec branch. Done once the spec is **built on its
   branch** (`builtOnBranch`): a multi-phase spec where every phase carries a `build_sha` or is terminal
   (`shipped`/`rejected` — the `isSpecAccumulationComplete` condition), a one-shot spec whose build job
   reached `completed`/`merged`, or any spec already `in_testing`/`shipped`/`folded`. Active while any
   phase is `in_progress` OR a live build job exists; needs-attention on a `needs_attention`/`needs_approval`
   build job.
3. **`spec-test`** — The pre-merge spec-test QA agent on the branch preview ([[spec-test-runs]], M3). Pending
   until **Build is done (built on branch)** — NOT until shipped; then active while a run is live OR no green
   verdict yet (so a live pre-merge run lights the node active, not grey); done iff `agent_verdict ===
   "approved"` AND 0 open regressions (mirrors `getAutoFoldEligibleSlugs` exactly so this and the fold gate
   can't disagree); needs-attention on `issues`/`error`/open regression.
4. **`security-test`** — The [[security-agent]] pre-merge review on the branch preview (M4). Pending until the
   **Spec Test node has cleared** (which itself requires Build done) — NOT until shipped; then active while
   the security-review job is `queued`/`claimed`/`building`/`needs_input`/`queued_resume` (or Spec-Test-done
   with no record yet); done on a clean `completed`; needs-attention on `needs_approval` (routed real-vuln
   fix) / `needs_attention` (needs-human finding). The fold gate requires this stage `done` before fold — so
   the timeline and the gate read the SAME state (`securityCompletedClean === true` in both places).
5. **`fold`** — The spec is archived to brain (`specs.status === "folded"`). Done iff folded; pending
   otherwise. By construction, a folded spec has every upstream stage done (built on branch, spec-test
   passed, security cleared, then shipped to main) so the full timeline reads checked.

## Types

- **`LifecycleStageName`** = `"spec-review" | "build" | "spec-test" | "security-test" | "fold"`.
- **`LifecycleStageStatus`** = `"pending" | "active" | "done" | "needs-attention"`.
- **`LifecycleContext`** — the inputs `deriveLifecycleStage` reads (the board / Control Tower computes these
  from data they already load): `status` (SpecStatus | "folded"), `valePass` (boolean | null), `phases[]`
  (status only), **`builtOnBranch`** (the branch-flow Build-done signal — see below), `buildLive`,
  `buildNeedsAttention`, `specTestVerdict` ([[spec-test-runs]] `AgentVerdict` | null),
  `specTestHasOpenRegression`, `specTestLive`, `securityLive`, `securitySurfaced`, `securityCompletedClean`.
  See the source for field-level docs. **`builtOnBranch`** is computed by [[build-lifecycle-context]]
  (`deriveBuiltOnBranch`) from the SpecCard's per-phase `build_sha` + the build job — the pure helper just
  reads it.
- **`LifecycleStage`** `{ name, label, status }` · **`LifecycleDerivation`** `{ current, currentStatus, stages[] }`.

## Exports

- **`deriveLifecycleStage(ctx)`** → `LifecycleDerivation` — the one pure entry point. Returns all 5 stage
  rollups plus the `current` stage (the earliest non-done) and its status (what the timeline pill renders).
  By construction every stage upstream of `current` is `done` — the inputs progress monotonically (Spec
  Test can't be done until Build is built-on-branch; Security can't be done until Spec Test clears; Fold
  can't be done until Security clears), so the rendered timeline naturally has a contiguous block of checks.
  The gates chain explicitly: `deriveLifecycleStage` passes `buildStage === "done"` into the spec-test
  deriver and `specTestStage === "done"` into the security deriver.
- **`LIFECYCLE_STAGE_LABELS`** — stable display strings for each stage (`"Spec Review"`, `"Build"`, …).
- **`LIFECYCLE_STAGE_ORDER`** — the 5 stages in order (the traversal contract).

## Callers

- **Phase 2 (shipped):** the shared 5-node timeline component [[../dashboard/roadmap|on `/dashboard/roadmap`]]
  — the board card AND the [[../dashboard/roadmap|spec-detail card]] (one shared component per the
  reusable-components rule). The page-level loader fetches the per-spec signals (latest job, latest
  spec_test_runs, human resolutions, the LIVE spec-test slug set via `getLiveSpecTestSlugs`, the per-slug
  security rollup via `getSecurityStateBySlug`) and hands them to the small context-builder library
  [[build-lifecycle-context]], which assembles the LifecycleContext this helper consumes. The Archive
  section synthesizes a fixed `FOLDED_DERIVATION` for compact "all 5 ✓" rendering on every folded entry.
  The presentational component lives at `src/app/dashboard/roadmap/LifecycleTimeline.tsx`.
- **Phase 3 (shipped):** `getAutoFoldEligibleSlugs` ([[spec-test-runs]]) requires the `security-test`
  rollup to be `done` before a spec is fold-eligible — both surfaces consume the SAME
  `getSecurityStateBySlug` signal so the Security node and the fold gate can never disagree. A live or
  surfaced security-review defers the fold (hitting the security rail = escalate, never fold past it).

## Gotchas

- **`status` widens past `SpecStatus`.** `SpecCard.status` (from [[brain-roadmap]]) is filtered to boardable
  values and never surfaces `folded` — a folded spec's card has `status: "shipped"` (per `dbStatusToSpecStatus`).
  This helper's `LifecycleContext.status` widens that to `SpecStatus | "folded"` so callers can pass the raw
  `specs.status` value and the Fold stage can read `done`. The Control Tower archive surface (and any future
  caller showing folded specs) must pass `"folded"`, not the boardable mapping.
- **Pure helper — no DB calls.** Every signal comes from `ctx`. Callers are responsible for loading
  `specTestVerdict` / `securityLive` / etc. from their respective DB sources. Phase 2 will add a small
  context-builder that wraps the per-page board loader; this module stays pure.
- **`valePass` is RETIRED** ([[../specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]]) — the deterministic authoring-time gate replaced Vale. The `in_review` status is no longer emitted on new specs, and `valePass` is no longer consulted. Legacy specs authored before the gate may carry a stale `valePass: false` on a planned/shipped spec (pre-retirement residue); the spec-review stage now always reads as `done`. The spec-review stage input `valePass` is deprecated; callers should not populate it for new specs.
- **Per-stage status must agree with the fold gate.** `getAutoFoldEligibleSlugs` and the Security node both
  read `securityCompletedClean` (the same `getSecurityStateBySlug` source) so the Security node and the
  fold gate can never disagree.
- **Build-done is built-on-branch, NOT shipped.** Spec Test + Security gate on `builtOnBranch` / the
  upstream node clearing — never on `status === shipped`. They run pre-merge on the branch preview, so a
  spec mid pre-merge testing (built on branch, `in_testing`/`in_progress`, not yet on `main`) correctly
  shows Build=done with a live Spec Test/Security node, instead of greying them for the whole pre-merge
  window. `builtOnBranch` is derived in [[build-lifecycle-context]] from per-phase `build_sha`
  (`isSpecAccumulationComplete`) or the one-shot build job's completed/merged terminal.

## Related

[[../specs/build-card-lifecycle-timeline]] · [[../lifecycles/spec-goal-branch-pm-flow]] · [[build-lifecycle-context]] ·
[[brain-roadmap]] · [[spec-test-runs]] · [[security-agent]] · [[spec-card-state]] · [[agent-jobs]] ·
[[../dashboard/roadmap]] · [[../dashboard/control-tower]]

---

[[../README]] · [[../../CLAUDE]]
