# Spec phase parser: skip `### Phase N` sub-headers under `## Verification` ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — the parser feeds the director's verdict surface, the build queue, and the fold pipeline; an over-count strands shipped specs in ⏳ limbo and bloats the groom queue with phantom candidates.

## Background — the bug

`parsePhasesWithLines` in `src/lib/spec-drift.ts:85-117` is the canonical phase counter for every brain spec — its output drives `phaseStatesFromRaw`, which writes `spec_card_state`, which every downstream system (director verdict surface, build queue, fold pipeline, board mirror) reads.

Line 91: `const isPhaseHeading = (l: string) => /^#{2,3}\s+Phase\b/.test(l);` — matches BOTH `## Phase` (H2) and `### Phase` (H3). PR #557 (`33a0ec09 fix(box): build guard accepts ### Phase (H3), not just ## Phase (H2)`) added H3 acceptance to support specs that wrap phases in `## Phases\n### Phase 1\n### Phase 2`. The fix has NO scope guard: an H3 `### Phase N` under ANY `## ` section is counted as a real phase.

The canonical brain-spec shape is:

```
## Phase 1 — endpoint
## Phase 2 — UI
## Phase 3 — handler
## Verification
### Phase 1 — endpoint
### Phase 2 — UI
### Phase 3 — handler
```

…which parses as 6 phases (3 real + 3 verification subheaders). Auto-flip flips ≤ N of the 6 (governed by code-on-main match), and the spec sits with phantom ⏳ phases that no build can ever satisfy. `bounce-escalation-back-to-director` is the concrete case that surfaced this: 3 real phases shipped in PR #559, but spec_card_state shows 5 ⏳ leftover (3 real-but-mis-flipped + the 3 verification subheaders, minus the 1 that did flip).

This silently degrades the whole status pipeline — every spec written to the canonical template is at risk of getting stuck.

## Phase 1 — boundary-aware H3 phase detection ⏳

- In `src/lib/spec-drift.ts`, gate the H3 branch of `isPhaseHeading` (or the scan loop) so an H3 `### Phase` line is only counted when the nearest preceding H2 line is `## Phases` (the legitimate wrapper PR #557 was for). H2 `## Phase N — …` headings remain unconditionally counted.
- An H3 `### Phase` line under `## Verification`, `## Completion criteria`, `## Safety / invariants`, `## Background`, or any other non-`## Phases` H2 MUST be skipped — not counted as a phase, not emoji-flipped, not surfaced on the board.
- The fallback `## Phases` bullet path (lines 119-145) is unchanged — it already has its own `inPhases` scope guard.
- Update the comment on lines 89-90 to document the new boundary rule so the next reader doesn't re-introduce the regression.

## Phase 2 — backfill the strand-spec roster + reconcile ⏳

- A read-only `scripts/_audit-spec-phase-overcount.ts` that runs `parsePhasesWithLines` against every `docs/brain/specs/*.md`, compares the H2-only count vs the current H2+H3 count, and lists every spec whose phase count drops under the new rule (these are the strand specs).
- For each strand spec, trigger a single fresh `runSpecDriftJob` pass so `spec_card_state` re-syncs against the corrected phase list (the existing reconcile path is idempotent and non-destructive — it only flips ⏳→✅ for phases whose code-on-main is present).
- A `director_activity` row `action_kind='phase_parser_strand_reconciled'` per spec carrying `before_count`, `after_count`, and the new shipped/planned counts, so the audit trail captures the cleanup.

## Verification

### Phase 1 — boundary-aware H3 detection
- A unit-level fixture with the canonical shape (3 H2 phases + a `## Verification` block containing 3 `### Phase N` subheaders) → `parsePhasesWithLines` returns exactly 3 phases, indices 0/1/2, titles taken from the H2 lines.
- A fixture with the wrapper shape (`## Phases\n### Phase 1\n### Phase 2\n### Phase 3`) → returns 3 phases, indices 0/1/2, titles taken from the H3 lines (PR #557's case continues to work).
- A fixture with an H3 `### Phase N` under `## Safety / invariants` or `## Background` → that H3 is NOT counted as a phase.
- A regression fixture mirroring `bounce-escalation-back-to-director`'s shape (3 H2 phases + 3 H3 verification subheaders) → returns exactly 3 phases.

### Phase 2 — strand backfill
- `npx tsx scripts/_audit-spec-phase-overcount.ts` → prints a JSON manifest of every spec whose H2+H3 count exceeded its H2-only count, with `slug`, `before_count`, `after_count`, `dropped_h3_titles`.
- After the manifest runs and each strand spec is re-drifted → `spec_card_state` for each strand spec shows the corrected phase count, with only the H2 phases counted, statuses matching code-on-main (no shipped flip lost — the reconcile is purely additive removal of phantom phases).
- One `director_activity` row per strand spec, `action_kind='phase_parser_strand_reconciled'`.
- `npx tsc --noEmit` clean.