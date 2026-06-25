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
| `milestone_id` | `uuid?` | typed FK → [[goal_milestones]]`(id)` `on delete set null` (constraint added by [[../specs/goals-milestones-tables-and-backfill]] Phase 1; populated by Phase 3 backfill). Null for standalone specs (function-mandate / regression / ad-hoc). Deleting a milestone unattaches its specs rather than orphaning them |
| `last_merge_sha` | `text?` | the build merge commit SHA that shipped this card — compared to `VERCEL_GIT_COMMIT_SHA` for `deploying` vs `live`. ([[../specs/spec-fold-from-db-row]] Phase 2 expand step — moved from `spec_card_state.last_merge_sha`. Currently dual-written by the [[../libraries/spec-card-state]] mirror writers; the cutover that makes this the read-side canonical is [[../specs/retire-spec-card-state]]) |
| `short_circuit` | `boolean?` | director-dismiss-park-and-short-circuit-spec — a shipped card closed CLEANLY without all phases shipping ("we changed our mind"). Paired with `short_circuit_reason`. NULL means "not short-circuited" ([[../specs/spec-fold-from-db-row]] Phase 2 expand step — moved from `spec_card_state.flags.short_circuit`) |
| `short_circuit_reason` | `text?` | the director's reason captured at the moment of short-circuit — rendered as the card sub-line ([[../specs/spec-fold-from-db-row]] Phase 2 expand step — moved from `spec_card_state.flags.short_circuit_reason`) |
| `vale_pass` | `boolean?` | spec-review-agent Phase 3 — Vale's quality verdict: `true` iff she ran the CHECKLIST and the spec passed (well-formed). A `vale_pass=true` spec is ready for Ada's disposition lane. Cleared on a status flip out of `in_review` ([[../specs/spec-fold-from-db-row]] Phase 2 expand step — moved from `spec_card_state.flags.vale_pass`) |
| `ada_disposition` | `text?` | spec-review-agent Phase 3 — Ada's disposition record: `autonomous_same ｜ autonomous_downgrade ｜ pending_upgrade`. Cleared when the spec leaves `in_review` ([[../specs/spec-fold-from-db-row]] Phase 2 expand step — moved from `spec_card_state.flags.ada_disposition`) |
| `merged_pr` | `integer?` | spec-status-phase-pr-provenance — the card-level shipping PR for a ONE-SHOT spec (no phases). Multi-phase specs record provenance per-phase in [[spec_phases]]`.pr` instead; this slot is for the no-phase shape only ([[../specs/spec-fold-from-db-row]] Phase 2 expand step — moved from `spec_card_state.flags.merged_pr`) |
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
- `supabase/migrations/20260725130000_goals_and_goal_milestones.sql` — adds the `specs_milestone_id_fkey` FK constraint pointing `milestone_id` at [[goal_milestones]] · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- `supabase/migrations/20260725140000_specs_card_state_columns.sql` ([[../specs/spec-fold-from-db-row]] Phase 2 expand step) — adds + backfills the six post-retirement columns (`last_merge_sha`, `short_circuit`, `short_circuit_reason`, `vale_pass`, `ada_disposition`, `merged_pr`) carrying the surviving spec_card_state fields. The contract step ([[../specs/retire-spec-card-state]]) cuts readers over + drops the mirror table · apply: `scripts/apply-specs-card-state-columns-migration.ts`
- One-time backfill from markdown ([[../specs/spec-body-table-and-backfill]] Phase 3): `scripts/backfill-specs-from-markdown.ts`

## Related

[[spec_phases]] · [[spec_card_state]] · [[spec_status_history]] · [[../libraries/specs-table]] · [[../libraries/brain-roadmap]] · [[../libraries/spec-card-state]] · [[../specs/spec-body-table-and-backfill]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../goals/db-driven-specs]]
