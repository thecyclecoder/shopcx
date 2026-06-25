# Phase-level PR + merge-SHA provenance for spec status

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — the spec/board system stays fast + honest (continues [[spec-status-db-driven]])
**Priority:** critical

## Problem

After spec-status-db-driven moved status to the DB, a phase is marked `shipped` by `reconcileSpecDrift` ONLY when it can verify that phase's code paths are on `main`. A **prose-only** phase (no declarable file paths) can never be verified, so a merged build leaves the spec stuck at `planned` despite shipping — the board shows the "Built" pill + Planned status, and the director re-grooms it forever (observed: `no-parked-specs-auto-route-needs-attention`, 5 prose phases, a whole-spec build merged → all still planned). The fix-via-heuristic ("count merged builds") is unreliable.

**The right model (CEO directives, 2026-06-24):**
- A merged build usually ships **one phase at a time** — a P1 merge ships P1, NOT the whole spec. BUT a single PR/commit/merge can ship **multiple phases at once** (a whole-spec build, or one commit that closes out P1+P2+P3) — so the tagging must allow N phases → the same PR/SHA, not assume 1:1.
- A phase should be tagged in the DB with the **PR # + merge SHA** that shipped it — so "shipped" is **provable/auditable**, not inferred. Multiple phases can share the same PR/SHA.
- Handle **all spec shapes**: one-shot (0 `## Phase` sections — the whole spec ships in one PR), single-phase (1 phase = the whole spec), multi-phase (N phases — each by its own PR over time, OR several in one PR).

**Which phases did THIS merge ship?** The authoritative signals, in order: (1) the phases `reconcileSpecDrift` flips from planned→shipped THIS pass (their code-path landed on main with this merge) — tag ALL of them with this PR/SHA; (2) for PROSE phases reconcile can't verify, the phase(s) the build's instructions name ("Phase N", possibly several), else the first not-yet-shipped. Never blanket-ship phases with no evidence.

## The model

`spec_card_state.phase_states[]` entries gain `pr?: number` + `merge_sha?: string` (jsonb — no migration). A phase is `shipped` because a specific build PR merged it; the entry records WHICH. One-shot specs (no phases) carry the shipping PR/SHA at the card level (`last_merge_sha` exists; add the PR).

## Phases

## Phase 1 — schema + merge-hook tagging
- `SpecCardPhaseState` += `pr`, `merge_sha` (DONE — src/lib/spec-card-state.ts).
- `applyMergedBuildEffects(workspaceId, slug, opts)` gains `prNumber` + `instructions` in opts. It derives WHICH phase the build shipped — the phase number parsed from the build's instructions (`phaseScopedInstructions` embeds "Phase N"), else the first not-yet-shipped phase, else (0 phases) the card level — and tags that phase `{status:'shipped', pr, merge_sha}`. reconcileSpecDrift's code-verified flips still apply (they get their own PR/SHA from a backfill or stay untagged-but-shipped).
- Callers `reconcileMergedJobs` + the GitHub-webhook merge path pass `job.pr_number` + `job.instructions`.
- One-shot specs: `markSpecCardMergeShipped` records the card-level PR (flags.merged_pr) + last_merge_sha.

## Phase 2 — backfill all active specs (WORKFLOW-driven, not regex)
A regex parser is too brittle (two parsers already disagreed on `## Fix` + `### Phase` specs). Instead a **workflow fans out one agent per live spec** (`audit-spec-shipped-state`) — each agent READS its spec with judgment (handles one-shot / single / multi-phase, `## Fix`/`## Phases`/H3, ignores `## Verification` mirror subheaders), then VERIFIES each phase against reality: the merged PRs (`gh pr view/diff`) + the code on `main` (grep src/). It returns a structured verdict per spec: `{slug, shape, overall_status, phases:[{index,title,status,pr,merge_sha,evidence}], confidence, notes}`.
- Input: the 49 live specs with merged build jobs (their `pr_number` + instruction snippets) — gathered from agent_jobs.
- Apply: `scripts/apply-spec-audit-verdicts.ts --in=<verdicts.json> --apply` writes each verdict into `spec_card_state` via `markSpecCardStatus` — every shipped phase tagged with its PR # + merge SHA; one-shots get `last_merge_sha`. Low-confidence verdicts are flagged for review before/after applying.
- Phases with NO shipping evidence → stay `planned`. The result: each shipped phase tagged with its REAL, agent-verified PR/SHA; the board shows the true in_progress/shipped state.

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
