# playbooks

Customer-service playbooks (e.g. unwanted_charge_subscription_dispute). Discoverable by Sonnet.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `slug` | `text` | — | URL-safe identifier, unique per workspace. Sol writes it on `ticket_directions.plan.playbook_slug` when she picks `chosen_path='playbook'` at first-touch — the writer at [[../libraries/ticket-directions]] `writeDirection` looks it up before the Direction lands, so an unknown slug is rejected there (not at executor step 0). Backfilled from `name` (`lower(name)` → non-alnum → `-`, trimmed) in `20260708120000_playbooks_slug.sql`. See [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]] Phase 1. |
| `description` | `text` | ✓ |  |
| `trigger_intents` | `text[]` | — | default: `'{}'` |
| `trigger_patterns` | `text[]` | — | default: `'{}'` |
| `priority` | `int4` | — | default: `0` |
| `is_active` | `bool` | — | default: `true` |
| `exception_limit` | `int4` | — | default: `1` |
| `stand_firm_max` | `int4` | — | default: `3` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `stand_firm_before_exceptions` | `int4` | — | default: `2` |
| `stand_firm_between_tiers` | `int4` | — | default: `2` |
| `exception_disqualifiers` | `jsonb` | — | default: `'[]'` |
| `disqualifier_behavior` | `text` | — | default: `'silent'` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[playbook_exceptions]].`playbook_id`
- [[playbook_policies]].`playbook_id`
- [[playbook_simulations]].`playbook_id`
- [[playbook_steps]].`playbook_id`
- [[tickets]].`active_playbook_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("playbooks")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("playbooks")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Discoverable by Sonnet via name OR any entry in `trigger_intents[]` (case-insensitive).
- `slug` is the stable identifier Sol names on the Direction (`plan.playbook_slug`) — the deterministic matcher / manual-apply route still key off `id`. Unique per workspace via `playbooks_workspace_slug_key`; the writer at [[../libraries/ticket-directions]] `writeDirection` treats an unknown slug as a typed rejection, not a silent no-op.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
