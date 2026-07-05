# god_mode_standing_grants

The founder's **"don't ask again" allowlist** for the CEO-grade god-mode approval model ([[../lifecycles/god-mode]] § CEO-grade approval model). One row per decision **category** the founder has granted standing approval to. When the box escalates a `risk='decision'` card (via `scripts/god-mode-plan.ts decide "<category>" …`), the decision primitive first checks this table — if the category is granted, it AUTO-APPROVES without raising a card and posts a note to the transcript.

Created by `supabase/migrations/20260911120000_god_mode_ceo_grade.sql` (apply: `scripts/apply-god-mode-ceo-grade-migration.ts`).

## Columns

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `workspace_id` | uuid FK → workspaces | `ON DELETE CASCADE` |
| `category` | text | the normalized decision category (lowercased, whitespace-collapsed, ≤80 chars — see [[../libraries/god-mode]] `normalizeCategory`) |
| `granted_by` | uuid | the owner who tapped "Don't ask again" (null on the token cockpit path) |
| `created_at` | timestamptz | `now()` |

`UNIQUE (workspace_id, category)` — one grant per category per workspace; `grantStanding` upserts on this key. Index `god_mode_standing_grants_workspace_idx` on `workspace_id`.

## The safety invariant

**Only `risk='decision'` cards are standing-grantable.** The catastrophic floor (`risk='destructive'`, the deterministic PIN gate) is NEVER written here — the "Don't ask again" button is suppressed on destructive cards in the UI AND the approve routes only grant when `existing.risk === 'decision'`. So a standing grant can never silently authorize dropping tables, mass-deleting data, force-pushing, or resetting the DB.

## Access

Service-role only (RLS enabled, no policies — same posture as [[god_mode_sessions]] / [[god_mode_approvals]]). All reads/writes go through the [[../libraries/god-mode]] SDK (`listStandingGrants` / `grantStanding` / `revokeStanding` / `isCategoryStandingGranted`) + the admin client, surfaced by the owner-gated `/api/god-mode/*` and token-authed `/api/god/[token]/*` routes.

## Written / read by

- **Written:** `grantStanding` (on approve + "Don't ask again"), `revokeStanding` (the "Standing approvals" list's ✕).
- **Read:** `isCategoryStandingGranted` (the `decide` primitive's auto-approve check), `listStandingGrants` (the GET session/cockpit payloads → the revocable UI list).

---

[[../README]] · [[../lifecycles/god-mode]] · [[../libraries/god-mode]] · [[god_mode_sessions]] · [[god_mode_approvals]] · [[../functions/ceo]]
