# Spec phase parser: skip `## Phase` / `### Phase` lines inside fenced code blocks ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — same supervision chain as [[spec-phase-parser-skip-verification-subsections]] (folded sibling): `parsePhasesWithLines` feeds the director verdict surface, the build queue, and the fold pipeline; phantom phases parsed out of documentation examples strand shipped specs in ⏳ limbo and bloat the groom queue.

## Background — the bug

PR #562 (`f19df1fb spec-phase-parser-skip-verification-subsections`) gated `parsePhasesWithLines` in `src/lib/spec-drift.ts` so an H3 `### Phase` line only counts when its nearest preceding H2 is `## Phases` — fixing the verification-subheader strand. That fix did NOT address a sibling source of phantom phases: H2/H3 `Phase` lines INSIDE a fenced code block (```` ``` ```` or `~~~`). The parser scans every line and does not track fence state, so any spec that embeds a canonical-shape EXAMPLE in a `## Background` / `## Anti-pattern` section still inflates its phase count.

The build agent's own PR #562 commit message captures the residual: the post-fix audit reports `this spec 10→5 from code-fenced examples` — meaning the now-folded sibling spec's `## Background` block (three `## Phase 1/2/3 — endpoint/UI/handler` lines wrapped in a ``` fence) is STILL counted as 3 real phases under the new parser. The same trap will fire on any future spec that documents the parser, the spec template, or a roadmap with fenced examples.

This is a discrete root cause separate from the H3 boundary rule: scope is by-fence, not by-section.

## Phase 1 — fence-state tracking in the parser ⏳

- In `src/lib/spec-drift.ts:parsePhasesWithLines`, add an `inFence` boolean tracked alongside `currentH2`. Toggle it whenever a line matches `/^\s*(```|~~~)/`. When `inFence` is true, skip the line for both phase-heading detection AND the `currentH2` update (a `## Whatever` inside a fence is documentation, not a real section boundary).
- Apply the same `inFence` guard to the fallback `## Phases` bullet path (the second loop at lines 119-145) — bullets inside a fenced example must not be counted as phase bullets.
- Update the parser comment (currently documenting the H3 boundary rule from PR #562) to add the fence rule so the next reader sees both invariants together.
- Unit fixtures in `src/lib/spec-drift.test.ts`: (a) a spec with `## Phase 1 — real ⏳` followed by a fenced block containing `## Phase 1 — example` → returns exactly 1 phase, titled `real`; (b) a regression fixture mirroring the folded sibling's `## Background` block (3 H2 + 3 H3 inside a ``` fence + 2 real H2 phases + a `## Verification` block) → returns exactly 2 phases; (c) `### Phase` lines inside a real `## Phases` wrapper still count when NOT inside a fence (PR #557 / PR #562 cases continue to pass); (d) a `~~~` fence behaves identically to a ``` fence.

## Phase 2 — strand backfill (re-run audit + reconcile) ⏳

- Re-run `npx tsx scripts/_audit-spec-phase-overcount.ts` (dry-run) — confirm the manifest now lists every spec whose count drops further once fenced-example phases are excluded.
- Re-run with `--apply` so `spec_card_state` re-syncs for each newly-affected strand spec; the existing audit writer already emits one `director_activity` row per spec (`action_kind='phase_parser_strand_reconciled'`) with before/after counts — no new code needed.
- `npx tsc --noEmit` clean.

## Verification

- `parsePhasesWithLines` returns exactly 2 phases when fed the folded sibling spec's markdown (the 2 real H2 phases — fenced-example H2/H3 lines and `## Verification` H3 subheaders both skipped).
- `parsePhasesWithLines` returns exactly 3 phases for the canonical `## Phases\n### Phase 1\n### Phase 2\n### Phase 3` wrapper shape — unchanged from PR #562.
- The dry-run audit identifies the spec count change; `--apply` writes one `director_activity` row per strand spec.
- `npx tsc --noEmit` clean.
