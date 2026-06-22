# spec_card_state

The live, **instant** project-management mirror the [[../dashboard/roadmap|Roadmap board]] reads DB-first ([[../specs/spec-card-db-companion]]). One row per `(workspace, spec_slug)`. Supersedes + retires the disabled `roadmap-reads-specs-from-git` (the per-request git read that burned the GitHub quota) — this solves the same "instant status" goal from our own DB instead.

A card's status used to be parsed only from the spec markdown's phase emojis **as bundled in the deployed build**, so a merge / drift flip / owner mark didn't show until a markdown edit + commit + **Vercel deploy** (minutes-to-hours of lag). The merge / drift / owner / build paths write this table the moment the event happens; the board overlays it on top of the markdown parse — **zero GitHub API calls for status**.

**Canonical-source rule:** the **markdown stays canonical** for spec content + the durable phase record; this is only the **board mirror** + transient flags that don't belong in committed markdown. The board takes whichever of (markdown, this) is **further along** (`resolveBoardStatus`), so this only ever moves a card forward and a markdown that's already ahead wins — no permanent divergence ([[../libraries/spec-drift|the drift reconciler]] + the fold keep the two in sync).

**Workspace-scoped** (the merge evidence + the per-workspace board). RLS: any authenticated user reads; service role does all writes (the writers hold the creds). Read by the board via `createAdminClient()`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `spec_slug` | `text` | the spec this mirrors (`docs/brain/specs/{slug}.md`) |
| `status` | `text` | derived overall status — `planned ｜ in_progress ｜ shipped ｜ rejected` · CHECK-constrained · the board signal |
| `phase_states` | `jsonb` | per-phase snapshot `[{ index, title, status }]` at write time (board future-use) · default `[]` |
| `flags` | `jsonb` | transient board flags `{ deploy_pending?, blocked?, … }` · default `{}` · merge-patched on write |
| `last_merge_sha` | `text?` | the build merge commit SHA that shipped this card — compared to `VERCEL_GIT_COMMIT_SHA` for `deploying` vs `live` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`spec_card_state_ws_slug` — a **unique index** on `(workspace_id, spec_slug)`. All writers go through `upsertCardState` ([[../libraries/spec-card-state]]) with `onConflict: "workspace_id,spec_slug"`: insert on first write, update on repeat. `flags` is **read-modify-write merged** (so a merge's `deploy_pending` doesn't clobber a `blocked` flag); `phase_states` / `last_merge_sha` are only touched when the writer supplies them.

## Writers (all instant, all best-effort)

- **Build merge** → `markSpecCardMergeShipped` (from [[../libraries/agent-jobs]] `reconcileMergedJobs`): `status` = post-merge status, `flags.deploy_pending = true`, `last_merge_sha` = the PR's `merge_commit_sha`.
- **Drift flip** → `markSpecCardStatus` (from [[../libraries/spec-drift]] `reconcileSpecDrift` — both the merge auto-flip and the Control-Tower cron): `status` + `phase_states`.
- **Owner status flip / one-tap drift flip** → `markSpecCardStatus` (from `/api/roadmap/status`, `/api/roadmap/spec-drift`).
- **spec-blockers** → `markSpecCardBlocked` sets/clears `flags.blocked`.

Every writer swallows its own error — a mirror-write failure must never break the underlying merge / flip / build path. The daily spec-drift reconcile is the backstop.

## Reads

`getSpecCardStates(workspaceId)` → `Record<slug, SpecCardState>` (the board's one read). The board then composes:
- `resolveBoardStatus(markdownStatus, state)` — forward-merge (DB-first, markdown-wins-if-ahead).
- `deploymentState(state, markdownStatus, VERCEL_GIT_COMMIT_SHA)` → `"deploying" ｜ "live" ｜ null` — the `shipped · deploying` → `shipped · live` chip.

## Gotchas

- **`deploy_pending` clears at READ time, not by a webhook.** The stored flag stays `true`; `deploymentState` decides `live` when the deployed SHA **is** `last_merge_sha`, or a later deploy already carries the flipped emoji (the parsed markdown reads shipped). So a merge whose SHA is already live shows `shipped · live`, never a stuck `deploying`.
- **Mirror, not source.** A row never edits the spec markdown — that's the merge/flip writers committing to `main`. This only reflects status for the board's instant render.
- **Forward-only.** `resolveBoardStatus` never demotes below the markdown; a mid-build card shows `building` (the live-job overlay) / `in_progress`, never a false `shipped`.

## Migration

`supabase/migrations/20260623130000_spec_card_state.sql` · apply: `scripts/apply-spec-card-state-migration.ts`

## Related

[[../specs/spec-card-db-companion]] · [[../libraries/spec-card-state]] · [[../libraries/brain-roadmap]] · [[../libraries/agent-jobs]] · [[../libraries/spec-drift]] · [[../dashboard/roadmap]] · [[spec_drift]]
