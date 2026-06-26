# spec_test_human_checks

The **owner's resolution state** for the box spec-test agent's **`needs_human`** checks ([[../specs/spec-test-agent]] Phase 2 — the human-test queue). The agent classifies the `## Verification` bullets it **can't** run (visual/UX or prod-mutating) as `needs_human` and records them in [[spec_test_runs]]; the **Developer → Human QA (optional)** queue (`/dashboard/developer/spec-tests/human-queue`) aggregates those across every shipped-unfolded spec, and the owner can mark each one tested. One row per `(workspace_id, spec_slug, check_key)`. The **agent never writes here** — only the owner-gated resolve API does (`POST /api/developer/spec-test/human-queue`).

**ADVISORY ONLY — never gates the fold (fold-on-spec-test-pass, task #29).** The fold into the brain fires on the **MACHINE spec-test pass** (Gate B, [[../libraries/spec-test-runs]] `getAutoFoldEligibleSlugs`), which does **not** consult this table. A waiting or `failed` resolution here does NOT block the fold, the brain, or the spec's progression — it's optional extra human QA the owner can run (or skip) at will. (Regressions — evidence-backed auto-`fail` checks in [[spec_test_runs]] — DO block the fold, but those live in the run row, not here.)

**Primary key:** `id` · **Unique:** `(workspace_id, spec_slug, check_key)` (upsert target)

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `spec_slug` | `text` | the `docs/brain/specs/{slug}.md` the check belongs to |
| `check_key` | `text` | **stable** key for the bullet = `sha1(normalized text).slice(0,16)` (`src/lib/spec-test-runs.ts` `checkKey`) — survives re-runs as long as the bullet text is unchanged (a reworded bullet becomes a new pending item) |
| `check_text` | `text` | the verbatim `## Verification` bullet (denormalized for the queue's **Done** list + audit) |
| `resolution` | `text` | `verified` (owner tested it, works) ｜ `failed` (tested, broken) ｜ `dismissed` (N/A) · default `verified` |
| `note` | `text?` | optional owner note |
| `resolved_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL |
| `resolved_at` | `timestamptz` | default `now()` (refreshed on upsert) |
| `created_at` | `timestamptz` | |

## Why a separate key (not the run's check array)

[[spec_test_runs]] `checks` is **agent-written and overwritten every run** — no place for human state. `check_key` is a content hash of the bullet text, so the owner's "tested" resolution **persists across re-runs**: the queue joins the latest run's `needs_human` checks against these rows in memory (`getHumanTestQueue`). Re-opening a check (`{ clear:true }`) deletes its row, sending it back to **waiting**.

## Indexes / RLS

- `spec_test_human_checks_ws_idx (workspace_id)` — the queue reads all resolutions for a workspace.
- RLS: `spec_test_human_checks_select` (workspace members read) · `spec_test_human_checks_service` (service role all). The resolve API writes via the service role after owner-gating.

## Who writes / reads

- **Writes:** `POST /api/developer/spec-test/human-queue` (owner only) → `upsertHumanCheckResolution` / `clearHumanCheckResolution` (`src/lib/spec-test-runs.ts`). Integrity-checked: `check_key` must equal `checkKey(check_text)`.
- **Reads:** `getHumanTestQueue` (`src/lib/spec-test-runs.ts`) → the Human-test queue page + the sidebar count badge.

## Migration

`supabase/migrations/20260620130000_spec_test_human_checks.sql` (apply: `scripts/apply-spec-test-human-checks-migration.ts`).

## Related

[[../specs/spec-test-agent]] · [[spec_test_runs]] · [[../dashboard/roadmap]] · [[../specs/improve-queue]] · [[../specs/box-spec-chat]]
