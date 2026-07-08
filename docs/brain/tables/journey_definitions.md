# journey_definitions

Journey configs — slug, channels, match_patterns, trigger_intent, step_ticket_status, priority. See [[../journeys/README]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `slug` | `text` | — |  |
| `name` | `text` | — |  |
| `journey_type` | `text` | — |  |
| `config` | `jsonb` | — | default: `'{}'` |
| `is_active` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `channels` | `text[]` | ✓ | default: `'{}'` |
| `match_patterns` | `text[]` | ✓ | default: `'{}'` |
| `trigger_intent` | `text` | ✓ |  |
| `description` | `text` | ✓ |  |
| `priority` | `int4` | — | default: `0` |
| `step_ticket_status` | `text` | — | default: `'open'` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[journey_sessions]].`journey_id`
- [[tickets]].`journey_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("journey_definitions")
  .select("id, slug, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("journey_definitions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `channels` is a text array — `social_comments` is **never** included.
- `match_patterns` is empty `[]` for non-auto-triggered journeys (e.g. account_linking — only ever prepended).
- `trigger_intent` is the slug Sonnet may return; lookup is case-insensitive vs `name` too.
- `slug` is the stable identifier Sol names on the Direction (`plan.journey_slug`) when she picks `chosen_path='journey'` at first-touch. Phase 1 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]] — the [[../libraries/cx-agent-sdk]] `listActionableOutcomes` catalog reader returns rows matched by `trigger_intent` + optional `channels` filter, and [[../libraries/ticket-directions]] `writeDirection` gates the slug against this table (`is_active=true`, workspace-scoped) before the Direction row lands, so an unknown slug bails there — not at Phase 2's `launchJourneyForTicket`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
