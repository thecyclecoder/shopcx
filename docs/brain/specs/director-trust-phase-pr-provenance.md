# Director lanes trust phase_states.pr (not status alone) + request-audit action

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/spec-status-db-driven]]

## Why

The phase-PR provenance change moved the ground truth for 'is this phase done?' from `phase_states[i].status` alone to `phase_states[i].pr` + `merge_sha`. The merge hook (`applyMergedBuildEffects`) is the only authoritative writer. My autonomous lanes (groom, init, escort) and my chat-emitted spec-status actions need to consult the `pr` tag, not just status, or they will:

- Treat a tagless `shipped` phase as done — when it's actually drift suspect (no merge ever stamped it).
- Treat a prose phase the old reconciler couldn't confirm as un-built — when it is built. The no-parked-specs-auto-route-needs-attention case (5 phases live on main, board said `planned`) is the canonical miss.
- Re-queue work that has already shipped, burning build lanes and CEO attention.
- Tempt the director surface to hand-flip phases to 'catch up' the board. I did exactly this on `agents-hub-role-inboxes` phase[5] earlier in this session — a phase with `status='shipped'` but no `pr` is itself drift, and the next reconciler will read it as suspect.

Today my only way to repair real drift is to flag it in words and wait for the CEO to run the audit workflow manually. There is no director action for `audit-spec-shipped-state` — so the easiest path of least resistance is the hand-flip, which is the move we want to remove.

## Phase 1 — Audit + fix director lanes to read `phase_states[i].pr`

Grep the director lane code (`src/lib/agents/`, the standing-pass / escort / groom / init paths, the spec-status executor) for every place that reads `phase_states[i].status` to decide 'is this phase shipped.' Where the answer should be 'iff `pr` is set,' update to require both.

Specifically:
- **Escort lane** (director-escort-inflight-specs): 'next actionable phase' = first `phase_states[i]` without a `pr` tag, NOT 'first with status != shipped'. A phase with `status='shipped'` and no `pr` is drift suspect — escort flags it, doesn't skip past it.
- **Groomer brief generator**: a phase with `status='shipped'` + no `pr` surfaces as drift suspect, NOT as ready-to-fold. A fully-shipped spec (every phase has a `pr`) is the only fold-ready state.
- **Init lane**: 'already shipped, skip' check requires every phase to carry a `pr` tag.
- **spec-status action executor**: reject a director-emitted phase flip to `shipped` that doesn't pair with a real `pr` (or auto-route it through Phase 2's request-audit path). Directors do NOT stamp `pr` tags directly — the merge hook does.

Deliverable: a short audit report (in the PR description) listing every call site touched + the fix applied.

## Phase 2 — `request-audit` director action

New director-surface action:

```
{type:'request-audit', slug:'<spec-slug>', reason:'<drift suspect | hand-flip cleanup | missing provenance>'}
```

Auto-applied on emit (same audit-is-the-gate model as `spec-status` and `dismiss-park`):
- Worker queues `audit-spec-shipped-state` scoped to the single spec slug.
- Owner-only: the spec's `Owner: [[../functions/{fn}]]` MUST match the requesting director's function — out-of-leash otherwise.
- Writes a `requested_audit` row to `director_activity` with the slug + reason; the audit run's verdict shows up in the activity feed.
- The audit walks the spec markdown + merged PRs + actual code-on-main, emits a high-confidence verdict per phase, and re-stamps `phase_states` with proper `{pr, merge_sha}` provenance (or leaves a phase `planned` if it can't confirm).

Cleanup: as the first use of the new action, request the audit on `agents-hub-role-inboxes` to repair my earlier hand-flip on phase[5]. The audit should either re-stamp the real phases with provenance + drop the phantom (if the parser-fix spec has shipped), or surface it as still-suspect (if not).

## Verification

### Phase 1 (shipped) — lane audit
- Grep result for `phase_states[*].status === 'shipped'` in `src/lib/agents/`: every hit either pairs with a `.pr` check or carries a justifying comment.
- A test spec with `phase_states = [{status:'shipped', pr:'#100'}, {status:'shipped'}]` makes escort pick phase 1 as next actionable (drift signal), not 'all done.'
- The groomer brief on the same spec surfaces 'phase 1 drift suspect (shipped, no pr)' — not 'ready to fold.'
- A director `spec-status` flip emitting `{phases:[{index:0, status:'shipped'}]}` without a paired `pr` is rejected with an explanatory error pointing at `request-audit`.

### Phase 2 (shipped) — request-audit action
- Emitting `{type:'request-audit', slug:'agents-hub-role-inboxes', reason:'cleanup of director hand-flip on phase[5]'}` from a Platform director queues `audit-spec-shipped-state` for that slug.
- `director_activity` carries the `requested_audit` row with the reason.
- The audit completes and `spec_card_state.phase_states` reflects the audit's verdict — either phase[5] dropped (if the parser-fix shipped) or re-stamped with proper provenance.
- Emitting `request-audit` on a spec whose `Owner:` isn't the requester's function is rejected as out-of-leash and logged.