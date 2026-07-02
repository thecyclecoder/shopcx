# spec_brain_refs

The structured replacement for the `**Brain refs:**` prose line ([[../specs/pm-structured-intent-and-refs]] Phase 2). ONE ROW PER (spec_id | phase_id → `brain_slug`). `phase_id=NULL` is a spec-level ref; a per-phase ref names its phase.

**Workspace-scoped via the parent** (inherited from `specs.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `spec_id` | `uuid` | FK → `specs(id)` on delete cascade |
| `phase_id` | `uuid?` | FK → `spec_phases(id)` on delete cascade. NULL for a spec-level ref (applies to the whole spec) |
| `brain_slug` | `text` | canonical `kind/name` path relative to `docs/brain/` (e.g. `libraries/author-spec`, `tables/specs`, `inngest/spec-review-on-mutate`) |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`spec_brain_refs_dedup` — unique on `(spec_id, coalesce(phase_id::text,''), brain_slug)`. The SDK writer [[../libraries/spec-brain-refs-table]] `replaceSpecBrainRefs(spec_id, refs[])` DELETEs every row for the spec then INSERTs `refs` — idempotent, no ordering assumption.

## Reads

- Forward lookup: [[../libraries/spec-brain-refs-table]] `listSpecBrainRefs(spec_id)` returns every ref (spec-level nulls first, then per-phase, then brain_slug).
- Reverse lookup: `specsTouchingBrainPage(brain_slug)` returns every spec that references a page — the "which specs touch this page" query.

## CI

`scripts/_check-brain-refs.ts` validates every `brain_slug` used anywhere in `docs/brain/specs/*.md`'s `**Brain refs:**` lines + every kind directory the SDK understands. A dangling ref fails CI (a wikilink to a missing page would point the builder at nothing).

## Migration

- `supabase/migrations/20260807150000_pm_structured_refs_and_typed_parent.sql` ([[../specs/pm-structured-intent-and-refs]] Phase 2) — creates the table + adds `specs.parent_kind` / `specs.parent_ref` for the typed parent · apply: `scripts/apply-pm-structured-refs-migration.ts`

## Related

[[specs]] · [[spec_phases]] · [[../libraries/spec-brain-refs-table]] · [[../libraries/brain-ref-suggest]] · [[../libraries/author-spec]] · [[../specs/pm-structured-intent-and-refs]]
