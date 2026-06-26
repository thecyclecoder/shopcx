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
does no DB I/O, and is unit-testable from a fixture (`scripts/_verify-build-lifecycle.ts`). No new column is
added — every stage status is **derived** from the existing data ([[brain-roadmap]] phases, the spec's
`vale_pass`, the latest [[spec-test-runs]] row, the [[security-agent]] `agent_jobs` state).

## Stages

The 5 stages, in order — a spec walks them left to right:

1. **`spec-review`** — Vale's CHECKLIST gate. Active while `vale_pass` is null on an `in_review` spec; done
   when Vale passes (or the spec has moved past `in_review` at all); needs-attention on a needs_fix verdict.
2. **`build`** — Build agent shipping the phases. Active while any phase is `in_progress` OR a live build
   job exists; done when every phase is `shipped` (cut `rejected` phases count as done); needs-attention
   on a `needs_attention`/`needs_approval` build job. For a one-shot spec (no `## Phase` sections), done
   when `status === shipped` / `folded`.
3. **`spec-test`** — The box spec-test QA agent ([[spec-test-runs]]). Pending until the spec has shipped;
   then active while a run is live OR no verdict yet; done iff `agent_verdict === "approved"` AND 0 open
   regressions (mirrors `getAutoFoldEligibleSlugs` exactly so this and the fold gate can't disagree);
   needs-attention on `issues`/`error`/open regression.
4. **`security-test`** — The [[security-agent]] post-merge review. Pending until the spec has shipped;
   then active while the security-review job is `queued`/`claimed`/`building`/`needs_input`/`queued_resume`
   (or post-ship with no record yet); done on a clean `completed`; needs-attention on `needs_approval`
   (routed real-vuln fix) / `needs_attention` (needs-human finding). Phase 3 of this spec extends the fold
   gate to require this stage to be `done` before fold — so the timeline and the gate read the SAME state.
5. **`fold`** — The spec is archived to brain (`specs.status === "folded"`). Done iff folded; pending
   otherwise. By construction, a folded spec has every upstream stage done (build shipped, spec-test
   passed, security cleared after Phase 3) so the full timeline reads checked.

## Types

- **`LifecycleStageName`** = `"spec-review" | "build" | "spec-test" | "security-test" | "fold"`.
- **`LifecycleStageStatus`** = `"pending" | "active" | "done" | "needs-attention"`.
- **`LifecycleContext`** — the inputs `deriveLifecycleStage` reads (the board / Control Tower computes these
  from data they already load): `status` (SpecStatus | "folded"), `valePass` (boolean | null), `phases[]`
  (status only), `buildLive`, `buildNeedsAttention`, `specTestVerdict` ([[spec-test-runs]] `AgentVerdict`
  | null), `specTestHasOpenRegression`, `specTestLive`, `securityLive`, `securitySurfaced`,
  `securityCompletedClean`. See the source for field-level docs.
- **`LifecycleStage`** `{ name, label, status }` · **`LifecycleDerivation`** `{ current, currentStatus, stages[] }`.

## Exports

- **`deriveLifecycleStage(ctx)`** → `LifecycleDerivation` — the one pure entry point. Returns all 5 stage
  rollups plus the `current` stage (the earliest non-done) and its status (what the timeline pill renders).
  By construction every stage upstream of `current` is `done` — the inputs progress monotonically (Spec
  Test can't be done until Build is; Security can't run until ship; Fold can't be done until Security
  clears under Phase 3), so the rendered timeline naturally has a contiguous block of checks.
- **`LIFECYCLE_STAGE_LABELS`** — stable display strings for each stage (`"Spec Review"`, `"Build"`, …).
- **`LIFECYCLE_STAGE_ORDER`** — the 5 stages in order (the traversal contract).

## Callers

- Phase 2 (this spec): the shared 5-node timeline component on `/dashboard/roadmap` (the build-card / spec-card)
  AND on Control Tower (one shared component per the reusable-components rule).
- Phase 3 (this spec): `getAutoFoldEligibleSlugs` ([[spec-test-runs]]) extended to require the `security-test`
  rollup to be `done` before a spec is fold-eligible — same signal both surfaces consume.

## Gotchas

- **`status` widens past `SpecStatus`.** `SpecCard.status` (from [[brain-roadmap]]) is filtered to boardable
  values and never surfaces `folded` — a folded spec's card has `status: "shipped"` (per `dbStatusToSpecStatus`).
  This helper's `LifecycleContext.status` widens that to `SpecStatus | "folded"` so callers can pass the raw
  `specs.status` value and the Fold stage can read `done`. The Control Tower archive surface (and any future
  caller showing folded specs) must pass `"folded"`, not the boardable mapping.
- **Pure helper — no DB calls.** Every signal comes from `ctx`. Callers are responsible for loading
  `specTestVerdict` / `securityLive` / etc. from their respective DB sources. Phase 2 will add a small
  context-builder that wraps the per-page board loader; this module stays pure.
- **`valePass` is only consulted when `status === "in_review"`.** A spec past `in_review` has Vale cleared
  by definition (the build pipeline refuses an in_review spec), so a stale `valePass: false` on a planned/
  shipped spec never reads as needs-attention.
- **Per-stage status must agree with the fold gate.** When Phase 3 extends `getAutoFoldEligibleSlugs`, the
  `securityCompletedClean` boolean and the gate's read of security-review terminal state MUST share one
  source so the Security node and the fold gate can never disagree.

## Related

[[../specs/build-card-lifecycle-timeline]] · [[brain-roadmap]] · [[spec-test-runs]] · [[security-agent]] ·
[[spec-card-state]] · [[agent-jobs]] · [[../dashboard/roadmap]] · [[../dashboard/control-tower]]

---

[[../README]] · [[../../CLAUDE]]
