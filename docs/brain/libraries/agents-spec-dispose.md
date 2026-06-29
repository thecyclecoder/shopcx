# libraries/agents-spec-dispose

The **spec-dispose** library — Ada's director-disposition lane ([[../specs/spec-review-agent]] Phase 3). The pipeline shape (CEO design): **author creates spec → Spec Review (Vale, quality) → Director (Ada) disposes Planned vs Deferred → Build.** An author only PROPOSES; a director DISPOSES.

**File:** `src/lib/agents/spec-dispose.ts`

## The asymmetric check

Ada disposes every Vale-passed `in_review` spec with an asymmetric check against the author's `flags.intended_status`:

| Author suggested | Ada decides | Route | What happens |
| ---------------- | ----------- | ----- | ------------ |
| `planned` | `planned` | **same** | Autonomous flip → `planned`. Silent. |
| `deferred` | `deferred` | **same** | Autonomous flip → `deferred` (+ `flags.deferred=true`). Silent. |
| `planned` | `deferred` | **downgrade** | Autonomous flip → `deferred`. CEO notification: "I moved this to deferred — want it built now? [Build now → planned]". |
| `deferred` | `planned` | **upgrade** | GATED. Spec parked `flags.ada_disposition='pending_upgrade'`; a 2-button CEO Approval Request (Planned / Deferred) lands in the agent inbox. |

The asymmetry: spending more than the author proposed (UPGRADE) confirms with the CEO; spending less (DOWNGRADE) is autonomous + a one-click override.

## Exports

### `selectDispositionCandidates(admin, workspaceId): Promise<DispositionCandidate[]>`

Every Vale-passed `in_review` spec the lane hasn't touched. Reads `spec_card_state` directly:
- `status='in_review'`
- `flags.vale_pass=true`
- `flags.ada_disposition` NOT set (idempotent re-fire — a card already disposed or parked is skipped)
- `flags.deferred` NOT set (out-of-band defer wins; the lane stays out of it)

`intended_status` defaults to `planned` when missing (every in_review row is a NEW spec; the author's bias is to build).

### `adaDispositionFor(candidate): AdaDecision`

The POLICY seam. Phase 3 ships a TRUST-THE-AUTHOR default — Ada agrees with `intended_status`, so the asymmetric check always lands on `kind='same'` and the sweep flips the card silently. The UPGRADE / DOWNGRADE plumbing (writers + CEO inbox card + notification) is fully wired so a future heuristic (build capacity, criticality, blocker pressure) can drop in here and the rest of the lane keeps working — no policy change needed downstream.

### `applyAdaDispositionDecision(admin, workspaceId, candidate, decision): Promise<{applied, ok}>`

Apply ONE disposition end-to-end:
- **same** → `applyAdaDisposition` (autonomous flip; consumes the disposition flags).
- **downgrade** → `applyAdaDisposition` (flip to deferred) + a CEO notification (override → planned).
- **upgrade** → `markSpecCardPendingUpgrade` (park the spec) + a CEO Approval Request (Planned / Deferred).

Records one `director_activity` row per action (`spec_dispose_same` / `spec_dispose_downgrade` / `spec_dispose_upgrade_proposed`). Idempotent + best-effort. The downgrade CEO notification (`emitDowngradeNotification`) now delegates to the shared [[spec-defer-audit]] `emitDeferNotification` — the SAME CEO-notification surface every programmatic defer reuses (the no-silent-spec-defer invariant) — passing Ada's own `ada-downgrade:{slug}` dedupe key + her director voice so her lane's surface stays distinct.

### `runAdaDispositionSweep(admin, workspaceId): Promise<DispositionSweepResult>`

Full sweep — selects every candidate and applies the decision to each. Returns per-branch counts for the pass log. Called inline at the tail of `runSpecReviewJob` so a pass + dispose lands in one cron tick.

## Director_activity action kinds

- `spec_dispose_same` — suggestion == decision (planned→planned OR deferred→deferred). Autonomous, silent.
- `spec_dispose_downgrade` — author suggested `planned`, Ada deferred. Autonomous flip + CEO notification.
- `spec_dispose_upgrade_proposed` — author suggested `deferred`, Ada wants `planned`. GATED; parked CEO Approval Request.

## Card flags Ada writes

- `flags.ada_disposition` — `'autonomous_same' | 'autonomous_downgrade' | 'pending_upgrade'`. Cleared on resolution (the next status flip out of in_review consumes it via the disposition writers).

## Callers

- `scripts/builder-worker.ts` → `runSpecReviewJob` — tails Vale with `runAdaDispositionSweep`.

## Brain links

[[../specs/spec-review-agent]] · [[agents-spec-review]] · [[platform-director]] · [[spec-defer-audit]] · [[../tables/director_activity]] · [[spec-card-state]] · [[../tables/dashboard_notifications]] · [[../dashboard/agents]]
