# libraries/spec-review-gate

Deterministic spec-review gate that replaces the Vale LLM lane at the authoring chokepoint. Runs the full mechanical checklist (contiguous `Phase N` sequence, Owner resolves to a `docs/brain/functions/` page, Parent resolves via DB lookup, Blocked-by slugs resolve and are acyclic, every phase carries `### Verification`, `customer_id` tables carry a companion data-tool plan) at author time and rejects a malformed spec on the spot with the exact failure named.

**File:** `src/lib/spec-review-gate.ts`

## Why this exists

[[../specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] Phase 1. The Vale checklist is purely mechanical — every check is a decidable predicate over the spec body plus the brain + DB state. Running it through a non-deterministic LLM produced the 2026-07-11 flake pair (Vale passed one director spec and failed an identical one on the SAME missing-intent rule, and separately bounced a spec for missing `**Why:**`/`**What:**` lines the renderer simply didn't print). Crystallizing a fully-mechanical agent into code is the correct lifecycle: cheaper, instant, and flake-free.

Bo still covers CODE reality downstream (does the referenced file exist, do prerequisites compile) at build time — no judgment is lost by moving the FORM check deterministic. Ada remains the supervisor of "nothing malformed enters the pipeline"; this gate is her tool.

## Two-layer split

The classic pattern the existing chokepoint gates ([[author-spec]] `assertEveryPhaseHasVerification` / `assertEveryNodeHasIntent`) already use:

- **`computeSpecReviewProblems(input, ctx)` → `string[]`** — PURE predicate. No I/O. Given the write payload plus a pre-resolved context (function slugs on disk, known spec + goal + mandate identifiers, the graph edges needed for the cycle check), returns the list of human-readable problems (empty when the spec is well-formed). Exported so it can be unit-tested without a Supabase client or a `docs/` scan.
- **`assertSpecReviewGate(workspaceId, input)`** — ASYNC wrapper. Materializes the context by scanning `docs/brain/functions/` + reading `public.specs` + `public.goals` + `public.goal_milestones` via the existing SDKs, then calls the pure predicate. On problems it throws `SpecReviewGateError` with the named defects (same fail-loud rail as `MissingVerificationError` / `MissingIntentError` / `InvalidParentError` in [[author-spec]]).

## Exports

- **`SpecReviewGateInput`** — the spec + phases the pure predicate reads: `slug`, `owner`, `parent`, `parent_kind`, `parent_ref`, `blocked_by`, `milestone_id`, `phases: [{ position, title, body, verification }]`.
- **`SpecReviewGateContext`** — the pre-resolved data the pure predicate needs to decide "resolves" checks without hitting disk / DB itself: `knownFunctionSlugs` (Set), `knownSpecSlugs` (Set), `blockedByGraph` (Map), `knownMandateRefs` (Set), `knownMilestoneIds` (Set), `knownGoalMilestones` (Map goal → milestone anchors).
- **`computeSpecReviewProblems(input, ctx)`** — the pure predicate. Returns the array of human-readable failures.
- **`buildSpecReviewGateContext(workspaceId)`** — async materializer for `SpecReviewGateContext`. Reads the brain functions dir, `listSpecs`, `listGoals`, and per-function `resolveFunctionMandates`.
- **`assertSpecReviewGate(workspaceId, input)`** — async wrapper called by [[author-spec]]. Throws `SpecReviewGateError` on any problem.
- **`SpecReviewGateError`** — thrown class carrying `slug` + `problems: string[]`. Callers in [[author-spec]] re-throw AS-IS so a downstream `instanceof SpecReviewGateError` discriminator survives.

## The checklist — what the gate enforces

Each check maps to a Vale defect string that used to arrive as an LLM verdict:

1. **Owner resolves** — `owner` (bare slug or bracket-stripped wikilink) must appear in `docs/brain/functions/{slug}.md`. Missing → `no **Owner:** line`. Unresolved → `Owner [[../functions/{slug}]] does not resolve to a docs/brain/functions/ page`.
2. **Phase-heading contiguity** — the phases must form the contiguous 1..N sequence with no duplicates. `Phase 1 appears twice`, `Phase 2 is missing — phases must be a contiguous 1..N sequence`, `Phase 3 is out-of-order`.
3. **Verification per phase** — every `phase.verification` must be non-empty. `Phase N has no ### Verification block`. Redundant with `assertEveryPhaseHasVerification` in [[author-spec]], but kept here so the aggregate verdict is self-contained + unit-testable.
4. **Parent resolves** — one of the three shapes must resolve:
   - `milestone_id` bound → must appear in `goal_milestones.id`.
   - `parent_kind='mandate'` + `parent_ref='{fn}#{mandate-slug}'` → must appear in the function's `## Mandates` (via [[function-mandates]]).
   - `parent_kind='milestone'` + `parent_ref='{milestone-uuid}'` → must appear in `goal_milestones.id`.
   - Untyped prose (`[[../goals/{slug}#{ms}]]` / `[[../functions/{slug}#{mandate}]]`) → must resolve to the real entity.
5. **Blocked-by resolves + acyclic** — each `blocked_by` slug must appear in `public.specs`, and adding the proposed edges must not create a cycle that includes this spec's own slug. Cycle detection is a DFS from the proposed edges over `blockedByGraph` (existing edges from `public.specs.blocked_by`).
6. **`customer_id` companion plan** — a phase body that carries both a create-table / add-column DDL AND a `customer_id` mention must have a companion `sonnet-orchestrator-v2` reference somewhere in the spec (CLAUDE.md hard rule — "add a Sonnet data tool in `sonnet-orchestrator-v2.ts`"). The regex is conservative (bounded ≤400 chars, only fires when DDL and `customer_id` co-occur in the same body) to avoid false positives on incidental `customer_id` lookups.

## Caller patterns

**Structured author path (`authorSpecRowStructured` / `submitSpec`):**

```ts
import { assertSpecReviewGate } from "@/lib/spec-review-gate";

// After the existing shape gates (assertEveryPhaseHasVerification / assertEveryNodeHasIntent /
// assertEveryPhaseHasBody / assertValidParent) and BEFORE upsertSpec:
await assertSpecReviewGate(workspaceId, {
  slug,
  owner: normalizeOwnerSlug(spec.owner),
  parent: spec.parent,
  parent_kind: effectiveParentKind ?? null,
  parent_ref: effectiveParentRef ?? null,
  blocked_by: spec.blocked_by ?? [],
  milestone_id: opts.milestoneId ?? null,
  phases: spec.phases.map((p, i) => ({
    position: i + 1, title: p.title, body: p.body, verification: phaseBodies[i].verification,
  })),
});
```

**Markdown author path (`authorSpecRowFromMarkdown`):** identical call after `assertValidParent`, using the `card`-parsed fields (`card.owner`, `mdParent`, `card.blockedBy`, and `phaseBodies`).

**Unit test surface (pure predicate):**

```ts
import { computeSpecReviewProblems, type SpecReviewGateContext } from "@/lib/spec-review-gate";

const ctx: SpecReviewGateContext = {
  knownFunctionSlugs: new Set(["platform"]),
  knownSpecSlugs: new Set(["existing-a"]),
  blockedByGraph: new Map([["existing-a", []]]),
  knownMandateRefs: new Set(["platform#build"]),
  knownMilestoneIds: new Set(),
  knownGoalMilestones: new Map(),
};
const problems = computeSpecReviewProblems({ slug: "my-spec", /* ... */ }, ctx);
// => human-readable defect strings, or [] on well-formed
```

Test file: `src/lib/spec-review-gate.test.ts` — one test per defect class (Owner, phase-contiguity, Verification, typed + untyped Parent, Blocked-by, cycle, `customer_id`).

Run: `npm run test:spec-review-gate` (= `tsx --test src/lib/spec-review-gate.test.ts`).

## Gotchas

- **Pure predicate → no I/O.** `computeSpecReviewProblems` MUST stay pure — no async, no `fs`, no Supabase. The context is materialized ONCE by `assertSpecReviewGate`; the predicate reads it as literal Sets/Maps. This is what keeps the unit tests fast + hermetic.
- **Redundant Verification check by design.** The `assertEveryPhaseHasVerification` gate in [[author-spec]] fires first + throws with a nicer error. This gate re-checks Verification so the aggregate verdict "did this spec pass Vale's checklist?" is self-contained (a unit test doesn't need to compose gates).
- **Owner slug is normalized** — the input accepts both a bare slug (`platform`) and a wikilink (`[[../functions/platform]]`) form. The caller in [[author-spec]] runs `normalizeOwnerSlug` first, but the gate handles either.
- **`customer_id` regex is conservative.** It only fires when a DDL keyword (`create table` / `alter table` / `add column`) co-occurs with `customer_id` within ≤400 characters. An incidental `customer_id` lookup in prose does NOT flag. `[\s\S]{0,400}` (not `[^\n]`) so a multiline `CREATE TABLE` block still matches its own `customer_id` column below the header.
- **Cycle detection is scoped to the ROOT.** `hasCycleThroughRoot(root, graph)` only cares about cycles that transitively pull this spec in on itself (a cycle among other specs that doesn't involve `root` is silent here — it's covered by upstream authoring paths on those other specs, if it ever appears in practice).
- **Empty `knownFunctionSlugs` fails safe.** A missing `docs/brain/functions/` dir returns the empty set — Owner check reports "does not resolve", which is the correct verdict when the brain is missing (the gate refuses to author, not silently pass).

## Related

[[author-spec]] · [[specs-table]] · [[function-mandates]] · [[goals-table]] · [[../tables/specs]] · [[../tables/goals]] · [[../tables/goal_milestones]] · [[../specs/retire-vale-spec-review-becomes-deterministic-authoring-gate]] · [[../functions/platform]]
