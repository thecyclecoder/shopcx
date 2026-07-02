# libraries/spec-brain-refs-table

SDK writer/reader for [[../tables/spec_brain_refs]] ([[../specs/pm-structured-intent-and-refs]] Phase 2), the structured replacement for the free-text `**Brain refs:**` prose line.

**File:** `src/lib/spec-brain-refs-table.ts`

## Exports

- **`replaceSpecBrainRefs(spec_id, refs[])`** → `Promise<void>` — DELETE + INSERT rewrite of a spec's brain-refs row set. Idempotent (a unique index on `(spec_id, coalesce(phase_id,''), brain_slug)` rejects dupes). Called by [[author-spec]] `authorSpecRowStructured` AFTER a successful `upsertSpec` — either from `opts.brainRefs` (author's picks) or from the derived-suggester scan over summary + phase bodies.
- **`listSpecBrainRefs(spec_id)`** → `Promise<SpecBrainRefRow[]>` — forward lookup, ordered by phase_id (nulls first, i.e. spec-level refs first) then brain_slug.
- **`specsTouchingBrainPage(brain_slug)`** → `Promise<{spec_id, ref_count}[]>` — reverse lookup. Returns the distinct specs that reference a given brain page + their ref count.
- **`parseBrainRefsLineToSlugs(line)`** → `string[]` — parse a `**Brain refs:** [[../libraries/foo]] · [[../tables/bar]]` line into canonical `kind/name` slugs. Case-insensitive, dedupes, strips the `../` prefix + alias segments.

## Row shape

`{id, spec_id, phase_id?, brain_slug, created_at, updated_at}` — see [[../tables/spec_brain_refs]].

## CI enforcer

`scripts/_check-brain-refs.ts` scans `docs/brain/specs/*.md` for `**Brain refs:**` wikilinks + validates every one resolves to a real `docs/brain/{kind}/{name}.md`. A dangling ref fails CI.

## Related

[[../tables/spec_brain_refs]] · [[brain-ref-suggest]] · [[author-spec]] · [[../specs/pm-structured-intent-and-refs]]
