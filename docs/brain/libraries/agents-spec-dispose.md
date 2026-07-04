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

The asymmetry: spending more than the author proposed (UPGRADE) confirms with the CEO; spending less (DOWNGRADE) is autonomous + a one-click override. [[../specs/vale-reasons-the-disposition]] Phase 2: **Vale's reasoned recommendation** now drives which branch fires (previously the stub always landed on `same`); Vale's plain-text reason is what the CEO reads on UPGRADE / DOWNGRADE surfaces.

## Exports

### `selectDispositionCandidates(admin, workspaceId): Promise<DispositionCandidate[]>`

Every Vale-passed spec awaiting disposition the lane hasn't touched. Reads `public.specs` via [[specs-table]] `listSpecs` (pm-db-agent-toolkit — no raw PM SQL). Since `specs-status-overrides-only` (migration `20260907130000`) `in_review` is no longer a STORED status, so the cohort is selected by the disposition signals directly (status-independent — `vale_pass=true` can only be set while the spec was in review and is CONSUMED once disposed, so it precisely identifies the pending cohort):
- `status !== 'folded'` (archived — never Ada's turn)
- `vale_pass=true` (Vale passed, awaiting disposition — null/false is not Ada's turn)
- `ada_disposition` NOT set (idempotent re-fire — a spec already disposed or parked is skipped)
- `deferred` NOT set (out-of-band defer wins; the lane stays out of it)

`intended_status` defaults to `planned` when missing (a freshly-authored spec's author bias is to build).

### `adaDispositionFor(candidate): AdaDecision`

The POLICY seam. Phase 3 shipped a TRUST-THE-AUTHOR stub — Ada agreed with `intended_status`, so the asymmetric check always landed on `kind='same'` and the sweep flipped silently. [[../specs/vale-reasons-the-disposition]] Phase 2 RETIRES that stub: `selectDispositionCandidates` reads Vale's `specs.vale_disposition` + `specs.vale_disposition_reason` (set on her PASS by [[agents-spec-review]] `applySpecReviewDecision`) onto the candidate, and `adaDispositionFor` COMPARES Vale's rec vs the author's `intended`:

| Vale's rec | Author intended | Branch | What happens |
| ---------- | --------------- | ------ | ------------ |
| `planned`  | `planned`  | **same** | Autonomous flip → `planned` (Vale's reason on the audit row). |
| `deferred` | `deferred` | **same** | Autonomous flip → `deferred` (Vale's reason on the audit row). |
| `deferred` | `planned`  | **downgrade** | Autonomous flip → `deferred` + CEO notification carrying VALE's reason. |
| `planned`  | `deferred` | **upgrade** | GATED — CEO Approval Request carrying VALE's reason (director still owns the outcome via the gate). |

Back-compat: a candidate with NO stored `vale_disposition` (pre-migration legacy pass) FALLS BACK to `intended` — `kind='same'`, reason names the fallback so the audit ledger reflects it. The sweep still flips silently, matching the Phase-3 behavior — nothing regresses mid-migration.

Director-owns-the-outcome: Vale only PROPOSES. The DIRECTOR still DISPOSES via the CEO gate (an UPGRADE remains gated). Same north-star principle as before: spending MORE than the author proposed confirms with the CEO; spending LESS is autonomous + a one-click override.

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
