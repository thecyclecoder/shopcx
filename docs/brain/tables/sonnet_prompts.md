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
| `status` | `text` | — | default: `'approved'` · enum: `proposed/approved/rejected/archived` |
| `derived_from_ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `proposed_at` | `timestamptz` | ✓ |  |
| `reviewed_at` | `timestamptz` | ✓ |  |
| `reviewed_by` | `uuid` | ✓ |  |
| `auto_decision` | `text` | ✓ | enum: `accept/reject/merge/supersede/revise`. NULL = not yet auto-reviewed. `human_review` is in the historical enum but the cron never emits it (downgraded to `reject` since 2026-06-03). |
| `auto_decision_at` | `timestamptz` | ✓ | When the auto-review or override fired |
| `auto_decision_reason` | `text` | ✓ | Brief reasoning (full per-decision history lives in [[sonnet_prompt_decisions]]) |
| `auto_decision_model` | `text` | ✓ | Model id, or `manual_override` |
| `auto_decision_confidence` | `real` | ✓ | 0..1 — the model's raw confidence (NOT floor-adjusted) |
| `superseded_by_id` | `uuid` | ✓ | → [[sonnet_prompts]].id — set on the old row when a new prompt supersedes it. Old row stays with `enabled=false`, `status='archived'`. Reversible. |
| `merged_into_id` | `uuid` | ✓ | → [[sonnet_prompts]].id — set when this proposal was merged into another canonical rule |
| `source_pattern_id` | `uuid` | ✓ | → [[daily_analysis_reports]].id — the report that surfaced this proposal |

## Foreign keys

**Out (this → others):**

- `derived_from_ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`
- `superseded_by_id` → [[sonnet_prompts]].`id`
- `merged_into_id` → [[sonnet_prompts]].`id`
- `source_pattern_id` → [[daily_analysis_reports]].`id`

**In (others → this):**

- [[sonnet_prompts]].`superseded_by_id` (self-FK)
- [[sonnet_prompts]].`merged_into_id` (self-FK)
- [[sonnet_prompt_decisions]].`sonnet_prompt_id`
- [[sonnet_prompt_decisions]].`merge_target_id`
- [[sonnet_prompt_decisions]].`supersede_target_id`

## Auto-decision lifecycle

```
status='proposed', auto_decision=NULL
   │
   │  sonnet-prompt-auto-review cron @ 11 UTC
   ▼
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│   accept     │   reject     │    merge     │  supersede   │    revise    │
├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ status=      │ status=      │ status=      │ status=      │ status=      │
│ approved     │ rejected     │ rejected     │ approved     │ proposed     │
│ enabled=true │ enabled=false│ merged_into  │ + old row    │ suggested_   │
│              │              │ set          │ archived +   │ revisions on │
│              │              │              │ superseded_  │ audit row    │
│              │              │              │ by_id set    │              │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
                                      │
                                      ▼
                          /dashboard/ai-analysis
                          Auto-decisions tab
                          (override → writes manual_override
                           row to sonnet_prompt_decisions)
```

The cron is decisive: no `human_review` outcome. Low confidence (< 0.55) → `reject` and the pattern resurfaces if real. Tentative accept (0.55 ≤ conf < 0.70) → also `reject`. See [[../inngest/sonnet-prompt-auto-review]] for the floors.

Every transition writes an append-only row to [[sonnet_prompt_decisions]] BEFORE mutating this row. See [[../lifecycles/ai-learning]] for the full self-improvement loop.

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
