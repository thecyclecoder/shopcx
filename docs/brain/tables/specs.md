# specs

The card row for every spec — title, summary, owner, parent, blocked_by, priority/critical, deferred, intended_status, the rolled-up `status`, and the `milestone_id` FK link. ONE row per `(workspace_id, slug)`. The body lives in [[spec_phases]] (one row per phase, a child table). Authored by [[../specs/spec-body-table-and-backfill]] (M1 of [[../goals/db-driven-specs]]).

**Today** the spec body is still parsed from `docs/brain/specs/{slug}.md` by [[../libraries/brain-roadmap]] `parseSpec` and [[spec_card_state]] is a status-only mirror. This table holds the BODY — once [[../specs/spec-readers-from-db-retire-parser]] flips the readers (M3) the markdown is no longer authoritative; until then this is the secondary copy that the M3 cutover will lean on.

**Workspace-scoped** (mirrors [[spec_card_state]]). RLS: any authenticated user reads; service role does all writes (the writers hold the creds). No client-side spec writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | `docs/brain/specs/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 minus any status emoji |
| `summary` | `text?` | first paragraph below the H1 — the card summary |
| `owner` | `text` | function slug (DRI) — `growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform`. Free-text for now (no hard FK) |
| `parent` | `text` | mandate or goal milestone string (same shape `parseSpec` carries today). Typed link lives on `milestone_id` |
| `blocked_by` | `text[]` | sibling spec slugs ([[../specs/spec-blockers]]) — prerequisite specs that must be `shipped` to clear the gate |
| `priority` | `text?` | `critical` or null — the **Priority:** flag (today on `spec_card_state.flags.critical`) |
| `deferred` | `boolean` | the **Deferred:** parked flag (today on `spec_card_state.flags.deferred`) — wins over phase rollup |
| `intended_status` | `text?` | `planned ｜ deferred` — the [[../specs/spec-review-agent]] disposition lane suggestion |
| `status` | `text` | rolled-up overall status — `in_review ｜ planned ｜ in_progress ｜ shipped ｜ deferred ｜ folded`. CHECK-constrained. **Trigger-maintained**: a direct write contradicting the phases is corrected on the next `spec_phases` write |
| `intended_status_set_by` | `text?` | who set `intended_status` (Slack disposition flow) |
| `repair_signature` | `text?` | the box Repair-Agent's signature for a repair-authored spec (drives the board's 🔧 Repair source chip) |
| `auto_build` | `boolean` | owner opt-out from [[../specs/spec-blockers]] auto-queue. Default `false` |
| `milestone_id` | `uuid?` | typed FK → `goal_milestones(id) on delete set null` ([[../specs/goals-milestones-tables-and-backfill]] M5 — the constraint is real; column itself dates to M1). Null for standalone specs. UPDATEs fire `specs_milestone_rollup_upd` which recomputes the parent milestone's `status` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`specs_ws_slug` — a **unique index** on `(workspace_id, slug)`. The backfill and every future writer go through this `onConflict` key (insert on first write, update on repeat).

## Rolled-up status

`specs.status` is maintained by a row-level trigger (`spec_phases_rollup`) on [[spec_phases]] and a column trigger (`specs_deferred_rollup`) on this table — both call `public.roll_up_spec_status(spec_id)`. Same rule [[../libraries/brain-roadmap]] `deriveStatus` / [[../libraries/spec-card-state]] `rollupPhaseStatus` enforce in app code today:

- `in_review` and `folded` are terminal-ish: the rollup never overwrites them (the disposition + the fold worker move them out explicitly).
- `deferred=true` wins over phase progress.
- Otherwise: any phase `in_progress` or any `shipped` (but not all) → `in_progress`; all (ignoring `rejected`) `shipped` → `shipped`; no phases → `planned`.

The DB enforcement closes the [[../specs/spec-review-agent]] "shipped with 1 phase" class of bug — impossible to commit `specs.status='shipped'` with non-shipped phases.

## Reads / writes

- **Reader cutover is M3** ([[../specs/spec-readers-from-db-retire-parser]]) — until then, the board / Slack flows / `getRoadmap` / `getSpec` still read markdown via [[../libraries/brain-roadmap]]. This table is the secondary copy.
- **Writer cutover is M2** ([[../specs/spec-authoring-writes-db-and-worker-materialize]]) — until then, authoring still writes markdown + this table via the [[../libraries/specs-table]] backfill path.
- M1 ([[../specs/spec-body-table-and-backfill]]) creates the relations + the one-time backfill from `docs/brain/specs/*.md`.

## Migration

- `supabase/migrations/20260713120000_specs_and_spec_phases.sql` — initial tables + rollup function + triggers · apply: `scripts/apply-specs-tables-migration.ts` · verify: `scripts/_verify-specs-schema.ts`
- `supabase/migrations/20260726120000_goals_and_goal_milestones.sql` — adds the `specs_milestone_id_fkey` FK constraint on `milestone_id` (→ `goal_milestones(id) on delete set null`) plus the `specs_milestone_rollup` / `specs_milestone_rollup_upd` triggers that bubble spec status changes up to the parent [[goal_milestones]] · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/spec-body-table-and-backfill]] Phase 3): `scripts/backfill-specs-from-markdown.ts`

## Related

[[spec_phases]] · [[spec_card_state]] · [[spec_status_history]] · [[goals]] · [[goal_milestones]] · [[../libraries/specs-table]] · [[../libraries/brain-roadmap]] · [[../libraries/spec-card-state]] · [[../specs/spec-body-table-and-backfill]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../goals/db-driven-specs]]
