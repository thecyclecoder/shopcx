# sonnet_prompts

DB-driven prompt rules for the Sonnet orchestrator. category: rule/approach/knowledge/tool_hint. Editable in Settings → AI → Prompts.

**Role in customer messaging:** this table answers the *"when X, do Y"* scenario layer. The orchestrator concatenates approved + enabled rows into its system prompt at runtime. Sits next to [[policies]] (the "what can we do?" layer) and [[../customer-voice]] (the "how does it sound?" voice layer). Three-layer model in [[../customer-voice]] § Three layers of customer communication.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `category` | `text` | — |  |
| `title` | `text` | — |  |
| `content` | `text` | — |  |
| `enabled` | `bool` | — | default: `true` |
| `sort_order` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `status` | `text` | — | default: `'approved'` |
| `derived_from_ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `proposed_at` | `timestamptz` | ✓ |  |
| `reviewed_at` | `timestamptz` | ✓ |  |
| `reviewed_by` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `derived_from_ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("sonnet_prompts")
  .select("id, title, created_at, updated_at, status")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("sonnet_prompts")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("sonnet_prompts")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- category: `rule` / `approach` / `knowledge` / `tool_hint`.
- Loaded at orchestrator init. Edits via Settings → AI → Prompts take effect on next message.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
