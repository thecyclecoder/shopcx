# libraries/spec-card-state

The read/write layer over the [[../tables/spec_card_state]] table — the live, instant project-management mirror behind the [[../dashboard/roadmap|Roadmap board]] ([[../specs/spec-card-db-companion]]). Supersedes the disabled `roadmap-reads-specs-from-git`.

**File:** `src/lib/spec-card-state.ts`

## Why this exists

The board parses a card's status from the spec markdown's `⏳/🚧/✅` phase emojis **as bundled in the deployed build** ([[brain-roadmap]]). So a status change — a build merging, a [[spec-drift]] flip, an owner mark — didn't show until a markdown edit + commit + Vercel **deploy** (the deploy-lag that made the board feel stale). This module is the DB companion: the merge / drift / owner / build paths write it the moment the event happens, and the board reads it **DB-first** (markdown fallback when no row exists). **No GitHub API calls for status** — the retired git-read approach burned the quota.

**Canonical-source rule:** markdown stays canonical for content + the durable phase record; this is only the board mirror + transient flags. `resolveBoardStatus` takes whichever of (markdown, mirror) is **further along**, so the mirror only ever moves a card forward and a markdown that's ahead wins.

## Types

- **`SpecCardState`** — `{ workspace_id, spec_slug, status: SpecStatus, phase_states: SpecCardPhaseState[], flags: SpecCardFlags, last_merge_sha, updated_at }`. `status` is the whole-spec `SpecStatus` (`Phase | "deferred"`); per-phase `status` stays `Phase`.
- **`SpecCardPhaseState`** — `{ index, title, status: Phase, pr?: number, merge_sha?: string }`. The optional `pr` + `merge_sha` ([[../specs/spec-status-phase-pr-provenance]]) record the PR # + merge commit SHA that SHIPPED this phase — so "shipped" is provable/auditable, not inferred. Stamped by the merge hook ([[agent-jobs]] `applyMergedBuildEffects`) and the one-time backfill (`scripts/backfill-phase-pr-provenance.ts`). Absent on a planned phase.
- **`SpecCardFlags`** — `{ deploy_pending?, blocked?, critical?, deferred?, short_circuit?, short_circuit_reason?, merged_pr? }` (transient). `merged_pr` is the card-level shipping PR for a **one-shot spec** (zero `## Phase` sections) — multi-phase specs carry their PR per-phase via `phase_states[i].pr` instead.
- **`DeployState`** — `"deploying" ｜ "live"`.

## Exports

- **`getSpecCardStates(workspaceId)`** → `Record<slug, SpecCardState>` — the board's one DB read.
- **`resolveBoardStatus(markdownStatus, state?)`** → `SpecStatus` — forward-merge of the markdown parse and the mirror (DB-first for the deploy-lag; markdown wins when it's already ahead). `rejected` (phase-level) passes through as the markdown value. A **`deferred`** markdown status is markdown-owned ([[../specs/director-drives-all-specs-and-deferred-status]] Phase 1): a deferred spec stays deferred and a once-deferred mirror never overrides an un-deferred (now Planned) markdown — only the CEO removing the marker un-defers it.
- **`deploymentState(state?, markdownStatus, deployedSha)`** → `DeployState | null` — the `shipped · deploying` → `shipped · live` signal. `live` when the deployed `VERCEL_GIT_COMMIT_SHA` **is** the card's `last_merge_sha`, or a later deploy already carries the flipped emoji (`markdownStatus === "shipped"`); else `deploying`. `null` for a card that isn't shipped / has no row / no merge SHA.
- **`markSpecCardStatus(workspaceId, slug, status, phaseStates?)`** — mirror a derived status + per-phase snapshot (drift reconciler, owner flips). No deploy flag.
- **`rollupPhaseStatus(phaseStates)`** → `Phase` — roll the per-phase states up to one board status, driven purely by the phases (never the H1 emoji): all ✅ → `shipped`; any ✅/🚧 but not all → `in_progress`; else `planned`. `rejected` (cut) phases are ignored; an empty set → `planned`. Used by the merge-write (Bug A fix below).
- **`markSpecCardMergeShipped(workspaceId, slug, { status, mergeSha, phaseStates?, prNumber? })`** — mirror a just-merged build: `flags.deploy_pending = true` + `last_merge_sha`, and **status = `rollupPhaseStatus(phaseStates)`** (not the caller's title-derived `status`). chain-and-cardstate-under-automerge **Bug A:** a multi-phase spec whose first phase shipped but whose H1 is still ⏳ derives `planned` from the markdown (the title wins in `deriveStatus`), which parked a part-shipped card in Planned — the phase rollup reads it as `in_progress`. `status` is the fallback only when `phaseStates` is absent/empty (a spec with no parsed phases). [[../specs/spec-status-phase-pr-provenance]] Phase 1: for a one-shot spec (no phases) the `prNumber` is stored on `flags.merged_pr` so the card carries its shipping PR; multi-phase specs ignore `prNumber` here (the per-phase PR is stamped on `phase_states[i].pr` by `applyMergedBuildEffects`).
- **`markSpecCardBlocked(workspaceId, slug, blocked)`** — set/clear the `blocked` transient flag (spec-blockers).
- **`markSpecCardForReview(workspaceId, slug, intendedStatus, audit)`** — the spec-creation entry point ([[../specs/spec-review-agent]] Phase 3). Sets the card to `in_review` AND records the author's `flags.intended_status` (a SUGGESTION for Ada's disposition lane, not binding). Every NEWLY-authored spec-creation surface calls this on first commit.
- **`markSpecCardValePassed(workspaceId, slug, audit)`** — Vale's pass leg ([[../specs/spec-review-agent]] Phase 3). Sets `flags.vale_pass=true` so [[agents-spec-dispose]]'s `runAdaDispositionSweep` can pick it up. Does NOT flip the status — a passed spec stays in `in_review` until Ada disposes.
- **`applyAdaDisposition(workspaceId, slug, decision, kind, audit)`** — Ada's disposition writer ([[../specs/spec-review-agent]] Phase 3). Flips a Vale-passed `in_review` spec to its final column (`planned` or `deferred`) and CONSUMES the lane flags (`intended_status`, `vale_pass`, `ada_disposition`).
- **`markSpecCardPendingUpgrade(workspaceId, slug, audit)`** — Ada's UPGRADE park ([[../specs/spec-review-agent]] Phase 3). Sets `flags.ada_disposition='pending_upgrade'`; the CEO's approval resolves to either `applyAdaDisposition('planned', …)` or `markSpecCardDeferred(true, …)`.
- **`markSpecCardBackToReview(workspaceId, slug, audit)`** — the SHARED back-to-review writer ([[../specs/spec-review-agent]] Phase 4). Any agent that spots a malformed/off spec (Vale on a re-check, Bo refusing to build on an empty/phaseless body, Ada's `spec-status` action with `status:'in_review'`, repair/regression noticing an authored spec doesn't pass the CHECKLIST, the CEO via the board control) flips the card back to `in_review` so it returns to Vale's queue (the build pipeline refuses an in_review spec). Consumes the prior lane signals: `vale_pass`, `ada_disposition`, `intended_status` are cleared so the next Vale + dispose pass start clean. Caller is responsible for recording the matching `director_activity` row (`spec_sent_back_to_review`) with their actor.

All writers are **best-effort** — `upsertCardState` swallows its own error so a mirror-write failure never breaks the underlying merge / flip / build path. `flags` is read-modify-write **merged** (a merge's `deploy_pending` doesn't clobber a `blocked`).

## Callers

- **Writers:** [[agent-jobs]] `applyMergedBuildEffects` (the shared merge-write run by both `reconcileMergedJobs` and the auto-merge path `handleAutoMergedBuildBranch`) · [[spec-drift]] `reconcileSpecDrift` (drift flip) · `src/app/api/roadmap/status/route.ts` + `src/app/api/roadmap/spec-drift/route.ts` (owner flips).
- **Reader:** `src/app/dashboard/roadmap/page.tsx` (the board — `getSpecCardStates` + `resolveBoardStatus` + `deploymentState`).
- `phaseStatesFromRaw(raw)` lives in [[spec-drift]] (it already parses phases with line numbers) and feeds the per-phase snapshot to the writers.

## Gotchas

- **`deploy_pending` is cleared at READ time, not by a webhook** — `deploymentState` derives `live` from the SHA compare. The stored flag staying `true` is harmless; a merge whose SHA is already live still shows `shipped · live`.
- **No circular import** — this module imports only `supabase/admin` + the `Phase`/`SpecStatus` *types* from [[brain-roadmap]]; [[spec-drift]] / [[agent-jobs]] / the routes import *it* (one direction).
- **`building` stays on the live-job overlay.** A mid-build card shows In progress via the board's existing active-`agent_jobs` overlay (instant + self-clearing on terminal status), which [[../specs/spec-card-db-companion]] generalizes — this mirror persists the *shipped* progression + deploy flag, the parts that actually had deploy-lag.

## Related

[[../tables/spec_card_state]] · [[../specs/spec-card-db-companion]] · [[brain-roadmap]] · [[spec-drift]] · [[agent-jobs]] · [[../dashboard/roadmap]]

---

[[../README]] · [[../../CLAUDE]]
