# cs_director_digests

The **weekly storyline digest** the CS Director (💬 June) posts to the founder — one row per (workspace, digest period). Replaces the per-ticket founder-escalation firehose with a BATCHED digest: systemic early-warnings ("3 refunds this week, all melted-in-transit → packaging signal") and precedent judgment calls are rolled up into a periodic `storylines` array instead of paging on every escalation. See [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]] and [[../goals/guaranteed-ticket-handling]] § M5.

Written by [[../libraries/cs-director-digest]] `composeCsDirectorDigest` (insert) — invoked by the weekly [[../inngest/cs-director-digest-composer]] cron. Phase 2 will surface the row on `/dashboard/agents/cs-director/digests` and stamp `ceo_replied_at` + `ceo_reply_action` when the founder acts on a storyline (widen leash / tighten leash / add policy / add rule).

**Migration:** `supabase/migrations/20260920120000_cs_director_digests.sql` · apply via `npx tsx scripts/apply-cs-director-digests.ts`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `digest_period_start` | `timestamptz` | — | inclusive lower bound of the digest window (the cron passes 7d back from run-at) |
| `digest_period_end` | `timestamptz` | — | exclusive upper bound of the digest window (the cron's run-at) — CHECK `> digest_period_start` |
| `storylines` | `jsonb` | — | array of `{ kind, title, evidence, proposed_action }` — CHECK `jsonb_typeof = 'array'` · default `[]` (a quiet week still writes a row) |
| `created_at` | `timestamptz` | — | default `now()` — when the composer materialized the row |
| `ceo_replied_at` | `timestamptz` | ✓ | Phase-2 stamp — set the moment the founder clicks any per-storyline action on the digest surface |
| `ceo_reply_action` | `jsonb` | ✓ | Phase-2 stamp — the founder's disposition (which storyline, which action, the resulting DB write) |

### `storylines` shape

An array of `CsStoryline`:

```jsonc
{
  "kind": "early_warning" | "precedent_call",
  "title": "≤160-char header — the storyline the founder reads first",
  "evidence": "≤800-char free-form body — cited row counts / ticket ids / reasoning",
  "proposed_action": {
    "type": "widen_leash" | "tighten_leash" | "add_policy" | "add_rule" | null,
    "payload": { ... }  // seed the Phase-2 reply surface consumes when the founder clicks the action
  }
}
```

`kind` distinguishes:
- `early_warning` — a recurring problem pattern (≥3 distinct tickets in the window with the same normalized `ticket_resolution_events.problem`). Systemic signal the per-ticket page can't see. Default `proposed_action.type='add_policy'`.
- `precedent_call` — one row per [[director_activity]] `cs_director_call` verdict in the window. `proposed_action.type` derives from the verdict's `decision`:
  - `escalate_founder` → `add_policy` (the CS Director hit her leash — the founder codifies the judgment)
  - `author_spec` → `add_rule` (a specific analyzer/rule gap — a `sonnet_prompts` seed until the spec ships)
  - `approve_remedy` → `null` (informational only — the CS Director acted in leash)

CHECK constraints keep the shape stable:
- `cs_director_digests_period_ordered` — `digest_period_end > digest_period_start`
- `cs_director_digests_storylines_is_array` — `jsonb_typeof(storylines) = 'array'`

## Indexes

- `cs_director_digests_workspace_created_idx` — `(workspace_id, created_at DESC)`. Phase 2's dashboard route reads the newest row per workspace.
- `cs_director_digests_workspace_period_idx` — `(workspace_id, digest_period_start DESC)`. The composer's per-period idempotency check ("did I already compose this week's digest for this workspace?").

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id.

**In:** none yet — Phase 2's reply surface will refer to a digest by id when it stamps `ceo_reply_action`, but the action-target tables ([[function_autonomy]], [[policies]], [[sonnet_prompts]]) are not FK-linked to the digest.

## Read paths

- **[[../inngest/cs-director-digest-composer]]** — reads `(workspace_id, digest_period_start)` before insert to guarantee idempotency; the cron's `retries:1` retry can't fan out two digests for the same week.
- **Phase 2** — `/dashboard/agents/cs-director/digests` reads `(workspace_id, created_at DESC LIMIT 1)` to render the latest digest with a per-storyline action panel.

## Row lifecycle

1. **Insert** — [[../libraries/cs-director-digest]] `composeCsDirectorDigest(admin, workspaceId, since, until)` stages a row with `digest_period_start=since`, `digest_period_end=until`, and the composed `storylines` array. Idempotent: if a row already exists for `(workspace_id, digest_period_start)`, the composer returns the existing row without inserting a duplicate.
2. **CEO reply (Phase 2)** — the founder clicks a storyline action on the dashboard; the API route stamps `ceo_replied_at=now()` + `ceo_reply_action = { storyline_index, action_type, resulting_row_id }` on the row AND performs the target mutation ([[function_autonomy]] leash change / [[policies]] insert / [[sonnet_prompts]] insert).

## RLS
Service-role only (RLS enabled with no policies). Every write goes through `createAdminClient()` from [[../libraries/cs-director-digest]] — per CLAUDE.md's "All writes go through `createAdminClient()`" invariant.

## Invariants
- **Never fail the composer on a source read error.** [[../libraries/cs-director-digest]] `composeCsDirectorDigest` catches every source-read error (director_activity read, ticket_resolution_events read) and returns the digest with the surviving storylines — a one-source outage must not skip the whole week.
- **Idempotent per (workspace, week).** The `existingDigestFor(workspaceId, periodStart)` lookup short-circuits a second insert for the same period — the cron's retry never fans out two digests.
- **A quiet week still writes.** `storylines` defaults to `[]` and the composer inserts a row with an empty array when no source produced signal, so the founder's dashboard always shows a "did the week compose?" surface (not an inferred absence).

---

[[../README]] · [[../functions/cs]] · [[../goals/guaranteed-ticket-handling]] · [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]] · [[../libraries/cs-director-digest]] · [[../inngest/cs-director-digest-composer]] · [[director_activity]] · [[ticket_resolution_events]] · [[../../CLAUDE]]
