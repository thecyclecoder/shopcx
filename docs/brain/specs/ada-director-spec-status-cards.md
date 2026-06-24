# ada-director-spec-status-cards

**Owner:** [[../functions/platform]]
**Parent:** Autonomous build platform mandate — keeps the director's control surface aligned with [[../specs/spec-status-db-driven]] (status moved from markdown to [[../tables/spec_card_state]]).
**Blocked-by:** none — [[../specs/spec-status-db-driven]] is shipped.

## Why

After [[../specs/spec-status-db-driven]] shipped, spec status / per-phase status / `flags.critical` / `flags.deferred` live in `spec_card_state` (markdown is content-only). The directors' chat surface still only has `spec-edit`, which commits markdown — useful for content (Blocked-by, autoBuild, body), useless for status. So when a director notices a spec needs to be flipped to `shipped` (work already merged), or marked `critical`/`deferred`, or a single phase needs to flip, they currently have no card to propose it through. The CEO is left to do it from the owner UI even though the director is the one who saw the gap.

This spec closes that gap: one new `spec-status` pending_action type, reusing the existing `markSpecCard*` writers behind the approval gate so the leash + audit trail are unchanged.

## Phases

### Phase 1 — `spec-status` card schema + worker handler

- Add a new pending_action shape in the director chat orchestration (alongside `spec`, `spec-edit`, `coaching`, `goal`, `directive`, `model_tier`):
  ```
  {
    type: "spec-status",
    summary: string,                          // one-line explanation
    slug: string,                              // existing spec slug (must exist in spec_card_state OR be a known docs/brain/specs/{slug}.md)
    status?: "planned" | "in_progress" | "shipped" | "rejected",  // optional whole-spec rollup
    phases?: [{ index: number, status: "planned" | "in_progress" | "shipped" | "rejected" }],  // optional per-phase flips
    critical?: boolean,                        // optional flags.critical flip
    deferred?: boolean,                        // optional flags.deferred flip
    reason: string                             // required — written to spec_status_history.reason
  }
  ```
- Approval handler in `scripts/builder-worker.ts` (sibling of the existing `spec-edit` branch around line 5510 / 5698): on CEO approval, for each populated field:
  - `phases[]` → merge into the row's existing `phase_states` and call `markSpecCardStatus(workspaceId, slug, rollup, mergedPhaseStates)` where `rollup` is `status` if provided, else `rollupPhaseStatus(mergedPhaseStates)`.
  - `status` (without `phases`) → call `markSpecCardStatus(workspaceId, slug, status, existingPhaseStates)`.
  - `critical` → `markSpecCardCritical(workspaceId, slug, critical)`.
  - `deferred` → `markSpecCardDeferred(workspaceId, slug, deferred)`.
- Every write appends a `spec_status_history` row with `actor="director:" + directorSlug` (e.g. `director:platform`) and `reason` from the card.
- Validation: reject if `slug` doesn't resolve to an existing spec_card_state row OR a docs/brain/specs/{slug}.md file (no creating phantom rows); reject if none of `status` / `phases` / `critical` / `deferred` is set; reject if a `phases[].index` is out of range for the markdown spec's actual phase count.

### Phase 2 — Director chat tool surface (Ada + future directors)

- Update the director chat system prompt (the AUTO/ASK/COACH/PLAN block, currently around scripts/builder-worker.ts:5566–5810) to list the new card type with one example, matching the format of `spec-edit`.
- Add a one-liner to the director instructions: "To flip a spec on the board (status / phase / critical / deferred) emit a `spec-status` card — never a `spec-edit` for status, because status is DB-only after spec-status-db-driven."
- Update [[../libraries/platform-director]] with the new card type and a worked example.

### Phase 3 — Approval UI parity

- Web inbox: render a `spec-status` card with a compact diff (current → proposed for each field, fetched from spec_card_state at render time).
- Slack approvals (the surface delivered by [[../specs/ada-slack-routed-approvals]]): same diff, Approve/Reject buttons.
- No new approval path — reuses the existing `approveRoadmapAction` spine.

## Out of scope

- Bulk flips. A card carries one slug. If a director wants to fix N specs, they emit N cards (matches `spec-edit`'s one-card-per-spec model).
- Writing to spec markdown. That's `spec-edit` and stays separate.
- A `spec-status` card from any non-director source (workers don't get this; they ship code and let the build-merge writer + drift reconciler update the row).

## Verification

- A director chat turn that emits a `spec-status` card with `status: "shipped"` for an existing spec flips `spec_card_state.status` on approval and appends one `spec_status_history` row with `actor=director:platform`.
- A card with a `phases[]` entry flips just that phase's `phase_states[i].status` and recomputes `status` via `rollupPhaseStatus` (unless the card also supplies `status` explicitly).
- A card with `critical: true` flips `flags.critical` without touching `status` / `phase_states`.
- A card with `deferred: true` flips `flags.deferred`, and the board reads it as Deferred (via `effectiveStatusFromState`).
- A card whose slug doesn't match any spec_card_state row OR docs/brain/specs/{slug}.md returns a validation error and the row is unchanged.
- A wrongly-flipped card is auto-corrected by the daily drift reconciler within 24h (the reversibility backstop the leash relies on).

## Related

[[../specs/spec-status-db-driven]] · [[../tables/spec_card_state]] · [[../tables/spec_status_history]] · [[../libraries/spec-card-state]] · [[../libraries/platform-director]] · [[../specs/ada-slack-routed-approvals]] · [[../libraries/spec-drift]]
