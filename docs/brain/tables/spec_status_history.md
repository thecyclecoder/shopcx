# spec_status_history

Append-only audit trail of every spec status / per-phase / critical / deferred transition, by `(workspace, spec_slug)`. Replaces what `git log docs/brain/specs/{slug}.md` gave us for free pre-[[../specs/spec-status-db-driven]]: now that status writes go straight to [[spec_card_state]] (no markdown commit, no deploy), the brain needs its own audit ledger to answer "who flipped this, when, why".

**Workspace-scoped.** RLS: any authenticated user reads; service role writes (every writer of `spec_card_state` also appends here).

**Primary key:** `id` · append-only — never updated, never deleted.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `spec_slug` | `text` | the spec whose state transitioned |
| `field` | `text` | which thing transitioned — `status ｜ phase ｜ critical ｜ deferred` · CHECK-constrained |
| `phase_index` | `int?` | 0-based phase index when `field='phase'`; null otherwise |
| `from_value` | `text?` | prior JSON-stringified value (`'"planned"'` / `'true'` / null on first write) |
| `to_value` | `text` | new JSON-stringified value (never null) |
| `actor` | `text` | who: `owner:<user_id> ｜ merge:<sha> ｜ drift:reconciler ｜ ada ｜ backfill ｜ box:<job_id> ｜ ...` |
| `reason` | `text?` | free-text rationale (the commit-message-equivalent that would have been written) |
| `at` | `timestamptz` | default `now()` |

## Writers

Every `spec_card_state` writer also appends here. The card-state writer wraps `upsertCardState` with an optional `history: HistoryEntry[]`; only transitions that **actually changed** a value get logged (a re-write with the same status is silent). See [[../libraries/spec-card-state]] for the helpers:

- `markSpecCardStatus(workspace, slug, status, phaseStates, { actor, reason })` — owner flip · drift reconciler · Ada drift-supervise.
- `markSpecCardMergeShipped(workspace, slug, opts)` — build merge.
- `markSpecCardCritical(workspace, slug, critical, { actor, reason })` — **Priority:** critical.
- `markSpecCardDeferred(workspace, slug, deferred, { actor, reason })` — **Deferred:** parked flag.

The history insert is itself best-effort: a missing audit table (migration not yet applied) is swallowed silently so the underlying mirror write never fails on a ledger absence.

## Reads

There's no live UI consumer today — this is an audit ledger. Read it ad-hoc to answer "who set this spec to X, when, why":

```sql
select at, field, phase_index, from_value, to_value, actor, reason
from public.spec_status_history
where spec_slug = '<slug>'
order by at desc;
```

## Indexes

- `spec_status_history_slug_at (workspace_id, spec_slug, at desc)` — the per-spec timeline read.
- `spec_status_history_field_at (workspace_id, field, at desc)` — cross-spec field-typed queries.

## Migration

`supabase/migrations/20260624130000_spec_status_history.sql` · apply: `scripts/apply-spec-status-history-migration.ts`. One-time backfill: `scripts/backfill-spec-status-from-markdown.ts` writes a `backfill` actor row per spec.

## Related

[[spec_card_state]] · [[../specs/spec-status-db-driven]] · [[../libraries/spec-card-state]]
