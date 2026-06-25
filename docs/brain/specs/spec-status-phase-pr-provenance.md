# Phase-level PR + merge-SHA provenance for spec status

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — the spec/board system stays fast + honest (continues [[spec-status-db-driven]])
**Priority:** critical

## Problem

After spec-status-db-driven moved status to the DB, a phase is marked `shipped` by `reconcileSpecDrift` ONLY when it can verify that phase's code paths are on `main`. A **prose-only** phase (no declarable file paths) can never be verified, so a merged build leaves the spec stuck at `planned` despite shipping — the board shows the "Built" pill + Planned status, and the director re-grooms it forever (observed: `no-parked-specs-auto-route-needs-attention`, 5 prose phases, a whole-spec build merged → all still planned). The fix-via-heuristic ("count merged builds") is unreliable.

**The right model (CEO directives, 2026-06-24):**
- A merged build ships **one phase at a time** — a P1 merge ships P1, NOT the whole spec. The next phase's own build ships it.
- A phase should be tagged in the DB with the **PR # + merge SHA** that shipped it — so "shipped" is **provable/auditable**, not inferred.
- Handle **all three spec shapes**: one-shot (0 `## Phase` sections — the whole spec ships in one PR), single-phase (1 phase = the whole spec), multi-phase (N phases, each shipped by its own PR over time).

## The model

`spec_card_state.phase_states[]` entries gain `pr?: number` + `merge_sha?: string` (jsonb — no migration). A phase is `shipped` because a specific build PR merged it; the entry records WHICH. One-shot specs (no phases) carry the shipping PR/SHA at the card level (`last_merge_sha` exists; add the PR).

## Phases

## Phase 1 — schema + merge-hook tagging
- `SpecCardPhaseState` += `pr`, `merge_sha` (DONE — src/lib/spec-card-state.ts).
- `applyMergedBuildEffects(workspaceId, slug, opts)` gains `prNumber` + `instructions` in opts. It derives WHICH phase the build shipped — the phase number parsed from the build's instructions (`phaseScopedInstructions` embeds "Phase N"), else the first not-yet-shipped phase, else (0 phases) the card level — and tags that phase `{status:'shipped', pr, merge_sha}`. reconcileSpecDrift's code-verified flips still apply (they get their own PR/SHA from a backfill or stay untagged-but-shipped).
- Callers `reconcileMergedJobs` + the GitHub-webhook merge path pass `job.pr_number` + `job.instructions`.
- One-shot specs: `markSpecCardMergeShipped` records the card-level PR (flags.merged_pr) + last_merge_sha.

## Phase 2 — backfill all active specs
A one-time script (`scripts/backfill-phase-pr-provenance.ts`): for every LIVE spec (file in docs/brain/specs/) with merged build jobs:
- Pull its merged `kind='build'` agent_jobs (each has `pr_number`, `instructions`, created_at). Fetch each PR's `merge_commit_sha` from GitHub.
- Map each merged build → the phase it shipped: parse "Phase N" from its instructions; else assign sequentially in merge order (1st merge → P1, 2nd → P2 …) for multi-phase; for single-phase → P0; for one-shot → card level. Dedupe (latest PR wins per phase).
- Write `spec_card_state.phase_states[idx] = {status:'shipped', pr, merge_sha}` for shipped phases; leave un-built phases `planned`. Roll up the overall status. Record a `spec_status_history` row (actor='backfill').
- Phases with NO merged build → stay `planned` (genuinely unbuilt). The result: each shipped phase tagged with its real PR/SHA; the board shows the true in_progress/shipped state.

## Phase 3 — surface + docs
- Board/spec-detail: show the PR # (link) per shipped phase ("P2 ✓ #519").
- Update tables/spec_card_state.md with the new phase_state fields; fold this spec.

## Phase 4 — every agent knows the convention (don't break the devops workflow)
The whole point is the autonomous loop keeps humming, so every box agent that reasons about spec status must understand the model — update the prompts/mandates:
- **Bo (build):** ship phase-by-phase — a build delivers ONE phase; on merge the worker tags THAT phase shipped with the build's PR + SHA. Bo's pre-flight state-check already reads code-on-main; reinforce that a phase is "done" iff a PR shipped it (the DB phase_state has a `pr`), and to build only the first un-shipped phase. A one-shot/single-phase spec is the whole thing in one PR.
- **Ada (director, grooming/escort):** a partially-shipped spec is one with ≥1 phase tagged shipped (`pr` set) and ≥1 still planned — the next un-shipped phase is what to escort/sequence. Read status from `spec_card_state` (already DB-driven). Don't treat a prose-only multi-phase spec as un-built just because reconcile can't verify it — the phase `pr` tags are the truth.
- **The merge hook (worker):** the authoritative writer — it tags the phase on merge. reconcileSpecDrift stays a backstop, never the primary signal for prose phases.
- **Guard:** the board's "Built" pill should mean "≥1 phase shipped" (or be replaced by the real N-of-M), so Built+Planned can't reappear as a contradiction.

This closes the loop that was breaking: prose-only multi-phase specs no longer get stuck `planned`, the director stops re-grooming shipped work, and "what shipped" is provable from the PR tags.

## Verification
- Every shipped phase in `spec_card_state` carries a `pr` + `merge_sha`; clicking it opens the PR.
- `no-parked-specs-auto-route-needs-attention` shows the correct N-of-M (the phases its merged PR(s) actually shipped), not all-planned and not all-shipped.
- A NEW multi-phase spec: P1 build merges → only P1 tagged shipped (with its PR); P2 still planned until its own build merges.
- A one-shot spec's single merged build → spec shipped, card carries the PR/SHA.
