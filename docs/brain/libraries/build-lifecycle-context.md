# libraries/build-lifecycle-context

The page-level adapter between the roadmap board's already-loaded signals and the pure Phase-1 helper
[[build-lifecycle]] — Phase 2 of [[../specs/build-card-lifecycle-timeline|build-card-lifecycle-timeline]].
"Pure transform on the way IN; tidy human label on the way OUT."

**File:** `src/lib/build-lifecycle-context.ts`

## Why this exists

[[build-lifecycle]]'s `deriveLifecycleStage(ctx)` is side-effect-free and takes a flat shape. The board
(`/dashboard/roadmap`) and the spec-detail card both already load every per-spec signal they need — the
[[brain-roadmap]] SpecCard, the latest [[agent-jobs]] row, the [[spec-test-runs]] verdict, the human
resolutions map. This module is the small **server-side translator** that maps those signals into the
helper's flat `LifecycleContext` once per page, then computes the **human pill label** for the timeline's
current node (the floating-pill replacement) so the roadmap board card and the spec-detail card render
IDENTICAL chips.

Two pure functions, no I/O, no DB calls — the page-level loader does the fetching.

## Exports

- **`buildLifecycleContext({ spec, job, testRun, humanResolutions, liveSpecTestSlugs, security, folded })`**
  → `LifecycleContext` ([[build-lifecycle]]). Inputs map 1:1 to the loaders the board already runs:
  - `spec`: a [[brain-roadmap]] `SpecCard`.
  - `job`: the spec's latest non-meta `agent_jobs` row (from `getLatestJobsBySlug`). Only `kind === 'build'`
    counts for the Build stage — a `spec-test`/`pr-resolve`/fold job belongs to a different stage and its
    `building`/`needs_approval` must not bleed into Build.
  - `testRun`: the latest [[spec-test-runs]] row (`getLatestSpecTestRuns`), or `null`.
  - `humanResolutions`: the `${slug}:${check_key}` map from `getHumanCheckResolutions` — used to compute
    `specTestHasOpenRegression` so the Spec Test node and the [[../recipes/fold-to-brain|fold gate]] can
    never disagree (mirrors `getAutoFoldEligibleSlugs` verbatim).
  - `liveSpecTestSlugs`: the per-board fetch of slugs with a live `spec-test` job (`getLiveSpecTestSlugs`).
  - `security`: per-slug rollup from [[security-agent]] `getSecurityStateBySlug`, or undefined.
  - `folded`: pass `true` when rendering a folded spec ([[brain-roadmap]] coerces folded → shipped on
    the SpecCard; this module re-widens it). The active board uses `false` (folded specs aren't boardable).

- **`lifecyclePillForCurrent(derivation, job, fold, valePass)`** → `{ label?, title? }` — the human pill
  for the timeline's current node, mirroring the floating-pill vocabulary BuildButton used to render
  ("Building…", "Vale pending", "Folding…", "Built · needs approval"). Pure. A `done` current stage
  (folded spec) returns `{}` (no pill — every node is checked).

- **`specTestHasOpenRegression(slug, run, humanResolutions)`** — boolean. Mirrors `getAutoFoldEligibleSlugs`'s
  regression definition so the Spec Test node + the fold gate can never disagree on the same data.

## Why pure (no DB I/O)

The page-level loader fetches once and re-uses the maps across every card. A per-spec round-trip from
inside this helper would explode the board's query count (N cards × M queries). Mirrors [[build-lifecycle]]'s
purity contract: signals in, derivation out, no surprises.

## Callers

- [[../dashboard/roadmap]] (the board card AND the spec-detail card): builds a LifecycleContext per spec,
  passes it through `deriveLifecycleStage`, then computes the pill label for the current node before
  rendering the shared `LifecycleTimeline` component.
- Future Control Tower archive surface (per the [[build-lifecycle#gotchas|widened-status note]]): a
  caller that renders folded specs passes `folded: true` to widen the status to `"folded"`.

## Gotchas

- **Build stage = `kind === 'build'` only.** A `pr-resolve`/`spec-test`/fold job carries its own lifecycle
  stage and its statuses must NOT spill into the Build node. The narrowing happens here, not in the
  page-level Pick — callers can pass the latest non-meta job from `getLatestJobsBySlug` directly.
- **`valePass: false` is only meaningful while `status === 'in_review'`** (see [[build-lifecycle]]). A
  stale `valePass: false` on a planned/shipped spec correctly maps to `null` here (the SpecCard surface
  exposes `valePass?: boolean`; this module passes through `null` when it's absent).
- **Pill copy mirrors BuildButton.** The label table here is the SAME vocabulary the floating pill used
  ("Queued", "Building…", "Needs approval"); a Built · needs approval state collapses two signals into
  one chip. Keep them in sync if BuildButton's copy ever changes.

## Related

[[build-lifecycle]] · [[../specs/build-card-lifecycle-timeline]] · [[brain-roadmap]] · [[spec-test-runs]]
· [[security-agent]] · [[agent-jobs]] · [[../dashboard/roadmap]]

---

[[../README]] · [[../../CLAUDE]]
