# media_buyer_shadow_reviews

Per-action review verdicts for the Media Buyer's shadow-mode plan actions (media-buyer-shadow-mode Phase 3) — the human-in-the-loop surface behind the CEO's non-negotiable "shadow / read-only before armed" guardrail (parent goal [[../goals/autonomous-media-buyer-supervision#m2-shadow-mode-read-only]] M2).

Every Media Buyer pass on a `mode='shadow'` [[iteration_policies]] row emits one `<verb>_shadow` [[director_activity]] row per plan action ([[../libraries/media-buyer-agent]] `buildShadowActivityRows`); this table records the Growth reviewer's concur / dissent / undecided verdict per action so the eventual flip to `armed` (spec `media-buyer-armed-flip-surface`) is grounded in evidence, not vibes.

**Primary key:** `id` · **Unique key:** `director_activity_id` (one review per shadow action — idempotent re-review via `.upsert(onConflict='director_activity_id')`).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `director_activity_id` | `uuid` | NOT NULL · UNIQUE · → [[director_activity]].id · ON DELETE CASCADE. One review per shadow action; `.upsert(onConflict='director_activity_id')` guarantees idempotency. A deleted `director_activity` row drops its review — no orphans. |
| `verdict` | `text` | NOT NULL · CHECK ∈ `{concur, dissent, undecided}`. `concur` = "if this were armed I'd let the executor apply it — evidence FOR the flip"; `dissent` = "the plan is wrong — evidence AGAINST arming this policy version"; `undecided` = "signal is thin — recheck next pass" (neutral park). |
| `rationale` | `text?` | Reviewer's free-text justification. Nullable — a concur/dissent without rationale is legal but the flip-surface aggregator will down-weight it. |
| `reviewer` | `uuid?` | → `auth.users(id)` · ON DELETE SET NULL. The workspace member who reviewed. Nullable so an agent-driven auto-concur path can leave it null; the human-facing route requires a signed-in user (enforced at [[../../src/app/api/growth/media-buyer/shadow-reviews/route.ts]]). |
| `reviewed_at` | `timestamptz` | NOT NULL · default `now()` — when the reviewer submitted. |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `media_buyer_shadow_reviews_touch_updated_at` trigger. |

## Indexes

- `media_buyer_shadow_reviews_ws_idx` — `(workspace_id, created_at desc)`. Workspace review feed (Growth tile reads this).

## Triggers

- `media_buyer_shadow_reviews_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Who writes / reads

- **Writer:** [[../../src/app/api/growth/media-buyer/shadow-reviews/route.ts]] POST — service-role upsert on `director_activity_id`. Guard-before-mutate: the route confirms the referenced `director_activity` row exists AND belongs to the caller's workspace before the write fires (a wrong / unknown id 404s deterministically).
- **Reader:** [[../../src/app/dashboard/marketing/ads/shadow-reviews/page.tsx]] — the Growth dashboard tile calls the sibling GET to list every `_shadow` [[director_activity]] row for the workspace that LACKS a review, ordered `director_activity.created_at desc`.

## Gotchas

- **The UNIQUE on `director_activity_id` is the idempotency guarantee.** A re-review upserts in place — never inserts a duplicate. A second POST for the same action UPDATES the verdict + rationale + `updated_at` (via the trigger).
- **The GET filter is `LIKE '%_shadow'`.** That matches the four shadow verbs Phase 2 emits — `media_buyer_promoted_winner_shadow` · `media_buyer_paused_loser_shadow` · `media_buyer_replenished_test_cohort_shadow` · `media_buyer_fatigue_replenish_triggered_shadow`. A future armed-mode verb would leak into this tile if it accidentally ended in `_shadow`; keep the naming convention narrow.
- **404 vs 400 on POST.** Missing/bad body ⇒ 400 (validation). Unknown `director_activity_id` (or one from a different workspace) ⇒ 404. The 404-on-cross-workspace check is the guard-before-mutate — without it an owner of workspace A could review a row in workspace B.
- **`reviewer` on service-role autonomous writes.** The route sets `reviewer = auth.user.id`. If a future automation writes shadow reviews via the service role (e.g. an auto-concur agent), it should leave `reviewer` null so the audit trail shows "agent" rather than a spoofed user.
- **The verdict semantics feed the flip surface.** Every `concur` is evidence for arming the current policy version; a single `dissent` blocks the flip until it's re-reviewed. `undecided` is a neutral park — it does NOT feed the flip aggregator.

## Migration

`supabase/migrations/20260708023500_media_buyer_shadow_reviews.sql` — apply with `npx tsx scripts/apply-media-buyer-shadow-reviews-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards). RLS: service-role full access + workspace-member SELECT (mirrors [[media_buyer_action_grades]]).

## Related

[[director_activity]] · [[iteration_policies]] · [[media_buyer_action_grades]] · [[../libraries/media-buyer-agent]] · [[../specs/media-buyer-shadow-mode]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]]
