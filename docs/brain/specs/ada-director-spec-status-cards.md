# ada-director-spec-status-cards

**Priority:** critical

**Owner:** [[../functions/platform]]
**Parent:** Autonomous build platform mandate — keeps the director's control surface aligned with [[../specs/spec-status-db-driven]] (status moved from markdown to [[../tables/spec_card_state]]).
**Blocked-by:** none — [[../specs/spec-status-db-driven]] is shipped.

## Why

After [[../specs/spec-status-db-driven]] shipped, spec status / per-phase status / `flags.critical` / `flags.deferred` live in `spec_card_state` (markdown is content-only). The directors' chat surface still only has `spec-edit`, which commits markdown — useful for content (Blocked-by, autoBuild, body), useless for status. So when a director notices a spec needs to be flipped to `shipped` (work already merged), or marked `critical`/`deferred`, or a single phase needs to flip, they currently have no action to take it through. The CEO is left to do it from the owner UI even though the director is the one who saw the gap.

This spec closes that gap: one new `spec-status` action type that the director **auto-applies** — no CEO approval card, no inbox surface. Status tracking is bookkeeping over already-shipped reality, every flip is reversible, and the daily drift reconciler is the safety net. Accountability is the audit trail (`spec_status_history` row stamped `actor=director:platform` with a `reason`), not a per-flip gate. This is inside the director's leash exactly because the underlying code/build approvals already happened — the row is just catching up to reality.

## Phases

### Phase 1 — `spec-status` action schema + worker handler

- Add a new director-chat action shape in the orchestration (alongside `spec`, `spec-edit`, `coaching`, `goal`, `directive`, `model_tier`):
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
- **Auto-applied** in `scripts/builder-worker.ts` at the same point the director-chat reply is persisted (sibling of the existing `spec-edit` branch around line 5510 / 5698): the worker iterates emitted `spec-status` actions and applies each one immediately. For each populated field:
  - `phases[]` → merge into the row's existing `phase_states` and call `markSpecCardStatus(workspaceId, slug, rollup, mergedPhaseStates)` where `rollup` is `status` if provided, else `rollupPhaseStatus(mergedPhaseStates)`.
  - `status` (without `phases`) → call `markSpecCardStatus(workspaceId, slug, status, existingPhaseStates)`.
  - `critical` → `markSpecCardCritical(workspaceId, slug, critical)`.
  - `deferred` → `markSpecCardDeferred(workspaceId, slug, deferred)`.
- Every write appends a `spec_status_history` row with `actor="director:" + directorSlug` (e.g. `director:platform`) and `reason` from the action. This row IS the accountability — there is no separate CEO-approval record.
- **No `pending_actions` row is written** for a `spec-status` action. It does not appear in the CEO inbox, the web approval surface, or the Slack approval thread. The reply text the director sends to the CEO mentions what was flipped (so the chat history shows the change), but no button is rendered.
- Validation (executed before the write): reject if `slug` doesn't resolve to an existing spec_card_state row OR a docs/brain/specs/{slug}.md file (no creating phantom rows); reject if none of `status` / `phases` / `critical` / `deferred` is set; reject if a `phases[].index` is out of range for the markdown spec's actual phase count. A rejected action is logged to `director_activity` with `outcome=invalid_spec_status_action` and surfaced in the reply text — it does not silently no-op.
- **Leash boundary:** only the spec's `Owner:` director (or the CEO from the owner UI) may auto-apply a `spec-status` action against it. A director emitting a `spec-status` for a spec they don't own is rejected as out-of-leash and logged — flipping someone else's spec still goes through the existing CEO path.

### Phase 2 — Director chat tool surface (Ada + future directors)

- Update the director chat system prompt (the AUTO/ASK/COACH/PLAN block, currently around scripts/builder-worker.ts:5566–5810) to list the new action type with one example, matching the format of `spec-edit`, and flag it explicitly as **auto-applied — no CEO approval, no inbox card** so the director frames the reply accordingly (state what was flipped, don't ask for approval).
- Add a one-liner to the director instructions: "To flip a spec on the board (status / phase / critical / deferred) emit a `spec-status` action — never a `spec-edit` for status, because status is DB-only after spec-status-db-driven. The action auto-applies; mention the flip in your reply so the CEO sees it in chat."
- Update [[../libraries/platform-director]] with the new action type, the auto-apply semantics, the owner-only leash boundary, and a worked example (e.g. flipping chat-fallback-absorbed-anthropic-overload-noise to shipped after detecting PR #442 merged).

### Phase 3 — Drift-reconciler awareness

- Confirm the daily drift reconciler ([[../libraries/spec-drift]]) treats director-applied flips the same as build-merge-applied flips when comparing `spec_card_state` against the brain + merged-PR ground truth: if the row claims `shipped` but no merged PR / brain page backs it, the reconciler reverts the row and writes a `spec_status_history` correction with `actor=drift-reconciler` + `reason="director:platform flip not backed by merged code"`.
- This is the reversibility guarantee the leash relies on — a wrong director flip is auto-corrected within 24h. Add a test (or extend the existing drift-reconciler test) that proves a director-stamped `shipped` row with no merged backing is reverted on the next pass.
- Surface a director_activity entry every time the reconciler reverts a director flip, so a recurring mis-flip pattern shows up on the daily watch.

## Out of scope

- Bulk flips. An action carries one slug. If a director wants to fix N specs, they emit N actions (matches `spec-edit`'s one-action-per-spec model).
- Writing to spec markdown. That's `spec-edit` and stays separate.
- A `spec-status` action from any non-director source (workers don't get this; they ship code and let the build-merge writer + drift reconciler update the row).
- A `spec-status` action against a spec the emitting director doesn't own. Cross-function status flips go through the spec's actual owner or the CEO owner UI — never via a foreign director.
- An approval UI. There is intentionally no `spec-status` card on the inbox or in Slack — the whole point of this revision is removing that gate.

## Verification

- A director chat turn that emits a `spec-status` action with `status: "shipped"` for an existing spec they own flips `spec_card_state.status` **immediately** (within the same worker turn that processes the chat reply) and appends one `spec_status_history` row with `actor=director:platform` and the action's `reason`.
- An action with a `phases[]` entry flips just that phase's `phase_states[i].status` and recomputes `status` via `rollupPhaseStatus` (unless the action also supplies `status` explicitly).
- An action with `critical: true` flips `flags.critical` without touching `status` / `phase_states`.
- An action with `deferred: true` flips `flags.deferred`, and the board reads it as Deferred (via `effectiveStatusFromState`).
- An action whose slug doesn't match any spec_card_state row OR docs/brain/specs/{slug}.md returns a validation error, the row is unchanged, and the director_activity entry records `outcome=invalid_spec_status_action`.
- An action emitted by a director against a spec they don't own is rejected as out-of-leash and logged — the row is unchanged.
- **No `pending_actions` row is created for a `spec-status` action**, and the CEO inbox / Slack-approval surface does NOT render an Approve/Reject card for it. The flip is visible in chat history (the director's reply text), in `spec_status_history`, and on the board — not as a pending approval anywhere.
- A wrongly-flipped action is auto-corrected by the daily drift reconciler within 24h, with a `spec_status_history` correction row stamped `actor=drift-reconciler` — proven by an explicit test.

## Related

[[../specs/spec-status-db-driven]] · [[../tables/spec_card_state]] · [[../tables/spec_status_history]] · [[../libraries/spec-card-state]] · [[../libraries/platform-director]] · [[../specs/ada-slack-routed-approvals]] · [[../libraries/spec-drift]]
