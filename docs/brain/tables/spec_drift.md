# spec_drift

Surfaced phase-emoji drift the [[../libraries/spec-drift|Spec-Drift Agent]] can't confidently auto-flip ([[../specs/spec-drift-agent]]). The reconciler auto-flips a phase ✅ when its claimed code is verifiably on `main` **and** a build PR has merged for the spec; the residue — a phase whose code is on main but with **no merged build on record** — lands here as an **open** row, rendered on the [[../dashboard/control-tower]] "Spec drift" section for a **one-tap owner flip** (rather than a wrong auto-flip).

**Workspace-scoped** (the merged-build evidence + the one-tap flip are per workspace — unlike the global [[loop_alerts]]). RLS: any authenticated user reads; service role writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `spec_slug` | `text` | the drifting spec (`docs/brain/specs/{slug}.md`) |
| `phase_index` | `int` | 0-based phase index — matches the board parser order + `/api/roadmap/status` `phaseIndex` |
| `phase_title` | `text` | the phase's cleaned title (for the tile) |
| `current_emoji` | `text` | the phase's stale emoji at detection (⏳ or 🚧) |
| `detail` | `text` | human-readable drift summary ("{slug} — P{n} (title) code is on main but still ⏳ …") |
| `status` | `text` | `open` (default) ｜ `resolved` · CHECK-constrained |
| `opened_at` | `timestamptz` | when first surfaced · default `now()` |
| `last_seen_at` | `timestamptz` | bumped each reconcile tick the drift persists · default `now()` |
| `resolved_at` | `timestamptz?` | when the phase flipped ✅ (owner tap / later reconcile) or stopped drifting |
| `created_at` | `timestamptz` | default `now()` |

## De-dupe spine

`spec_drift_one_open_per_phase` — a **partial unique index** on `(workspace_id, spec_slug, phase_index) where status = 'open'`. The reconciler's `syncDriftRows` contract mirrors [[loop_alerts]]:

- **First surfaced sight** (no open row) → `insert`.
- **Still drifting** (open row exists) → bump `last_seen_at` + refresh `detail`/`phase_title`/`current_emoji`. No duplicate row.
- **No longer drifting** (phase flipped, or now has a merged build → auto-flipped) → `update status='resolved', resolved_at=now()`.

The owner one-tap flip (`POST /api/roadmap/spec-drift`) resolves the specific `(slug, phase_index)` row immediately; the next reconcile tick reconciles the rest.

## Gotchas

- **Surfacing ≠ flipping.** A row here means "code on main but the agent won't auto-flip" — it never changes the spec markdown by itself; only the owner's tap (or a later merged build) does. The agent never marks a spec **verified**.
- **Genuinely-pending phases never land here.** A phase whose named code isn't (fully) on main — a fan-out / follow-on — is left untouched (no row), the guardrail against over-flagging multi-phase specs.

## Migration

`supabase/migrations/20260622170000_spec_drift.sql` · apply: `scripts/apply-spec-drift-migration.ts`

## Related

[[../specs/spec-drift-agent]] · [[../libraries/spec-drift]] · [[../inngest/spec-drift-reconcile]] · [[../dashboard/control-tower]] · [[../libraries/agent-jobs]] · [[../libraries/brain-roadmap]] · [[loop_alerts]]
