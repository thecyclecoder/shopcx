# Critical-spec board pip + set-from-board control ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — extends the coaching seat ([[director-proposed-goals]] pattern) + the standing pass under [[../goals/devops-director]]
**Deferred:** split from [[director-executable-plans-and-priority]] — not needed now: the `critical` flag is already derived in [[../libraries/brain-roadmap]] (`SpecCard.critical`, brain-roadmap.ts:255), already orders the build queue (`findInitCandidates` sorts critical-first, #455), and is already settable via a `spec-edit` card or a `directive`'s `criticalSpecs`. The board pip is human-visibility on the roadmap board only — the priority lane functions without it (the CEO is already marking specs critical through the functional marker).

## Phase 1 — render + set the `**Priority:** critical` marker on the board ⏳
- **Render a pip/lane on the [[../dashboard/roadmap|board]]:** surface `SpecCard.critical` (already derived from the line-anchored `**Priority:** critical` marker in [[../libraries/brain-roadmap]], mirroring the `deferred` derive, #423) as a visible pip/badge or a dedicated lane on the roadmap dashboard, so a human can SEE at a glance which specs are critical (and therefore queue-first / gating).
- **Settable from the board:** a board control to toggle a spec's `**Priority:** critical` marker directly (commit the line-anchored marker into `docs/brain/specs/{slug}.md`, same line-anchored convention the derive reads). Today the marker is only settable via Ada's `spec-edit` card or a `directive`'s `criticalSpecs`.

### Verification
- On `/dashboard/roadmap`, a spec carrying `**Priority:** critical` renders a visible pip/lane; a non-critical spec does not.
- Toggling the control from the board commits/removes the line-anchored `**Priority:** critical` marker in the spec file, and the derived `SpecCard.critical` flips accordingly. `npx tsc --noEmit` clean.