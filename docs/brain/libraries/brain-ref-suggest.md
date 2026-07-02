# libraries/brain-ref-suggest

Author-time SUGGESTER for the `**Brain refs:**` line ([[../specs/spec-brain-refs]] Phase 2). Given a spec body, scans for the src/ files, tables, and existing brain wikilinks it names, resolves each to a `docs/brain/{libraries|inngest|tables|lifecycles|integrations|…}/{name}.md` that ACTUALLY exists on disk, and returns the top ≤4 as a `**Brain refs:** [[../libraries/foo]] · [[../lifecycles/bar]] · …` line the [[author-spec]] chokepoint injects below the last metadata header. Phase 1 taught the [[../.claude/skills/build-spec|build-spec]] skill to Read the `**Brain refs:**` line FIRST as the authoritative brain slice for the build; Phase 2 makes that line cheap to author.

**File:** `src/lib/brain-ref-suggest.ts`

## Why this exists

Phase 1 of [[../specs/spec-brain-refs]] gave specs an optional `**Brain refs:**` header the build-spec skill Reads first for accuracy-first brain scoping (right pages, not three wrong ones). But hand-picking those refs is friction: authors know the src/ file they're touching, not which `docs/brain/…` page maps to it. This module is the deterministic mapping table — src/lib basename → libraries page, src/lib/inngest basename → inngest page, `public.<table>` → tables page — with an fs-verified existence check so a dangling ref never lands on the spec (a broken wikilink would point the builder AT nothing, worse than no refs).

The suggestion is BEST-EFFORT: nothing mappable ⇒ no line (Phase 1's grep-the-brain fallback covers it). The author's explicit `**Brain refs:**` line always wins (never overridden) — a subsequent spec-chat refine turn can strip or replace whatever we injected.

**Editable AND skippable.** A refine can either REPLACE the injected wikilinks (edit the value of the header — the author's picks always win) OR SKIP the refs entirely by leaving a durable persisted signal. Two equivalent skip forms, either satisfies the [[../specs/fix-spec-brain-refs]] regression fix:

- **Empty header:** `**Brain refs:**` on its own (no wikilinks after the colon) — a persisted "author picked NONE" that `hasBrainRefsLine` already treats as "never re-inject."
- **HTML-comment marker:** `<!-- brain-refs: skip -->` placed anywhere in the spec body — invisible in the rendered spec but part of the persisted text, so it survives re-authoring. Use this when the author doesn't want the empty header artifact in the summary block.

Without one of these markers, a refine that fully removed the `**Brain refs:**` line would be re-injected on the next author (indistinguishable from a brand-new spec that never had refs). The persisted signal is what makes SKIP a durable author choice, not a per-refine erasure.

## Exports

- **`hasBrainRefsLine(body)`** → `boolean` — line-anchored probe for an existing `**Brain refs:**` metadata line (case-insensitive). A prose mention of the phrase inside a paragraph is NOT a false positive (regex is `/^…$/im`).
- **`BRAIN_REFS_SKIP_MARKER`** → `string` — the durable "author explicitly skipped" HTML-comment marker (`<!-- brain-refs: skip -->`). Invisible in rendered markdown; survives re-authoring because it rides in the spec body. Paired with the equivalent empty `**Brain refs:**` header form.
- **`hasBrainRefsSkipMarker(body)`** → `boolean` — probe for the HTML-comment skip marker (whitespace-tolerant, case-insensitive).
- **`hasBrainRefsSkip(body)`** → `boolean` — probe for EITHER durable skip signal: the HTML-comment marker OR an empty `**Brain refs:**` header. Both mean "author explicitly picked NONE — do not re-inject on the next author." This is what makes the suggestion SKIPPABLE (the [[../specs/fix-spec-brain-refs]] regression fix): without a persisted signal, a refine that removed the injected line would be re-inserted next author. Callers who prevent re-injection use this; callers who only care about the header shape use `hasBrainRefsLine`.
- **`deriveSuggestedBrainRefs(body, brainDir?, max=4)`** → `BrainRefCandidate[]` — scan + resolve. Order:
  1. Existing brain wikilinks the author already dropped in the body (`[[../libraries/foo]]`, `[[libraries/foo]]`) — these come first. Only build-relevant kinds (libraries / inngest / tables / lifecycles / integrations / recipes / journeys / playbooks / dashboard) are harvested; functions / goals are org-chart taxonomy, not build context. Wikilinks on METADATA header lines (`**Owner:**` / `**Parent:**` / `**Blocked-by:**` / `**Regression-of:**` / `**Brain refs:**` / `**Repair-signature:**` / `**Regression-signature:**`) are SKIPPED — the Owner line's `[[../functions/{slug}]]` is the classic false positive this guard blocks.
  2. `src/lib/inngest/{name}.ts` → `docs/brain/inngest/{name}.md`.
  3. `src/lib/{anywhere}/{name}.ts` → `docs/brain/libraries/{name}.md` (basename-only lookup — matches the observed brain convention, e.g. `src/lib/agents/agent-grader.ts` → `docs/brain/libraries/agent-grader.md`). Skips `.test.ts` / `.spec.ts`.
  4. `public.{table}` and `.from('{table}')` → `docs/brain/tables/{table}.md`.

  Each candidate is verified on disk (`existsSync(join(brainDir, rel))`) before it's returned — the caller never gets a dangling ref. Deduped by wikilink target. Never throws.
- **`formatBrainRefsLine(refs)`** → `string` — pretty-format `**Brain refs:** [[../libraries/foo]] · [[../tables/bar]] · …`. `[]` → `""`.
- **`injectSuggestedBrainRefsLine(body, refs)`** → `string` — splice the formatted line just below the LAST existing metadata header (Owner / Parent / Blocked-by / Priority / Deferred / Auto-build / Repair-signature / Regression-of / Regression-signature) so it sits in the same block Phase 1's parser scans. No-op when refs is empty, when the body already carries a `**Brain refs:**` line (never clobber), or when no metadata header exists to anchor to. Returns the original body when injection isn't safe.
- **`suggestBrainRefs(body, brainDir?)`** → `{ body, refs }` — one-shot: derive + inject. The single entry point [[author-spec]] `authorSpecRowFromMarkdown` calls; `authorSpecRowStructured` uses `deriveSuggestedBrainRefs` + `formatBrainRefsLine` directly (its summary column carries the refs line as free text).

## Callers

- [[author-spec]] `authorSpecRowFromMarkdown` — every markdown-authoring surface (spec-chat finalize/verify, director followup, repair-agent, regression-agent, security-agent, coverage-register) hits this before the `upsertSpec` write; a body with no `**Brain refs:**` line gets one proposed. The author's own picks are passed through unchanged.
- [[author-spec]] `authorSpecRowStructured` — the goal planner's structured author (no markdown parse). Scans `summary + phases[].body`; prepends the formatted line to `summary` when the summary doesn't already carry one.
- [[../.claude/skills/spec-chat|spec-chat]] finalize (implicit) — the skill also instructs the box to propose the line proactively. The deterministic suggester here is the safety net.

## Mapping notes

**Why basename-only for libraries.** Historically `docs/brain/libraries/{name}.md` uses the SOURCE FILE'S basename regardless of its subdir (e.g. `src/lib/agents/agent-grader.ts` → `docs/brain/libraries/agent-grader.md`, not `docs/brain/libraries/agents-agent-grader.md`). Basename-only + fs-verify keeps the map honest — a real page is a real page, a missing one drops out.

**Why cap at 4.** Phase 1's convention says 0-4 refs. More than 4 is grep-the-brain territory, not scoping. Deterministic caller (`max=4`) matches the [[../.claude/skills/build-spec|build-spec]] skill's reading budget for the first-Read block.

**Why lifecycles / integrations aren't scanned directly.** src/ files don't name lifecycles or integrations by path — they're derived pages, not source files. The scanner still resolves them when the author uses a `[[../lifecycles/foo]]` wikilink in the body (branch 1). A lifecycle miss is a benign gap: Phase 1's grep-the-brain fallback finds it via `docs/brain/README.md`.

## Related

- [[../specs/spec-brain-refs]] — Phase 1 (build-spec reads the line) + Phase 2 (this suggester)
- [[../.claude/skills/build-spec|build-spec]] — the consumer of the `**Brain refs:**` line at build time
- [[../.claude/skills/spec-chat|spec-chat]] — the box that also proposes the line at finalize
- [[author-spec]] — the DB-write chokepoint that wires this in
- [[build-spec-materializer]] — worker-materialized body carries the `**Brain refs:**` line in the summary block
