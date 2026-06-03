# sonnet_prompt_decisions

Append-only audit log of auto-review decisions on [[sonnet_prompts]]. One row per Claude Opus decision (cron), per human override, or per safety test. Every state change to `sonnet_prompts.auto_decision` writes a row here first — this is the per-decision history of how a proposal moved through accept / reject / merge / supersede / human_review / revise.

**Role in the loop:** the audit-first invariant. Phase 3 of the spec says: write THIS row before mutating the prompt, so we always have a record of what the model saw + what it decided, regardless of whether the subsequent prompt-row write succeeded. Replays + investigations key off this table.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `sonnet_prompt_id` | `uuid` | — | → [[sonnet_prompts]].id |
| `decision` | `text` | — | `accept` / `reject` / `merge` / `supersede` / `human_review` / `revise` |
| `confidence` | `real` | — | 0..1 — what the model returned (NOT the floor-adjusted final state) |
| `reasoning` | `text` | — | One-paragraph model reasoning; safety overrides append `[SAFETY] ...` |
| `references_json` | `jsonb` | — | `[{type, id, why}]` — what the model cited (prompt/policy/ticket/voice_rule) |
| `suggested_revisions` | `text` | ✓ | Populated only when `decision='revise'` |
| `merge_target_id` | `uuid` | ✓ | → [[sonnet_prompts]].id — only when `decision='merge'` |
| `supersede_target_id` | `uuid` | ✓ | → [[sonnet_prompts]].id — only when `decision='supersede'` |
| `input_proposal` | `jsonb` | — | The proposal as the model received it |
| `input_similar_prompts` | `jsonb` | — | Top-K similar approved prompts the model compared against |
| `input_policies` | `jsonb` | — | Active policies considered |
| `input_source_tickets` | `jsonb` | — | Contributing tickets from [[daily_analysis_reports]] / [[ticket_analyses]] |
| `input_voice_doc_hashes` | `jsonb` | ✓ | `{customer_voice: sha, operational_rules: sha, ui_conventions: sha}` — for replay equivalence checks |
| `model` | `text` | — | Model id used. `manual_override` for human actions |
| `input_tokens` | `int` | ✓ | |
| `output_tokens` | `int` | ✓ | |
| `cost_usd_cents` | `int` | ✓ | Computed via `usageCostCents()` |
| `latency_ms` | `int` | ✓ | |
| `source` | `text` | — | `cron` / `manual_override` / `safety_test` |
| `performed_by` | `uuid` | ✓ | `user_id` when `source='manual_override'` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`
- `sonnet_prompt_id` → [[sonnet_prompts]].`id`
- `merge_target_id` → [[sonnet_prompts]].`id`
- `supersede_target_id` → [[sonnet_prompts]].`id`

**In (others → this):** _None._

## Common queries

### Last 50 decisions in a workspace
```ts
const { data } = await admin.from("sonnet_prompt_decisions")
  .select("decision, confidence, reasoning, model, source, created_at, sonnet_prompt_id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Accepts today (drives the daily-cap check)
```ts
const since = new Date(); since.setUTCHours(0, 0, 0, 0);
const { count } = await admin.from("sonnet_prompt_decisions")
  .select("id", { count: "exact", head: true })
  .eq("workspace_id", workspaceId)
  .eq("decision", "accept")
  .eq("source", "cron")
  .gte("created_at", since.toISOString());
```

### Full history for a single proposal
```ts
const { data } = await admin.from("sonnet_prompt_decisions")
  .select("*")
  .eq("sonnet_prompt_id", promptId)
  .order("created_at", { ascending: true });
```

### Decisions forced to human_review by the confidence floor
```ts
const { data } = await admin.from("sonnet_prompt_decisions")
  .select("sonnet_prompt_id, confidence, reasoning")
  .eq("workspace_id", workspaceId)
  .eq("decision", "human_review")
  .ilike("reasoning", "%[SAFETY] confidence_floor%")
  .order("created_at", { ascending: false }).limit(50);
```

### Human overrides since X
```ts
const { data } = await admin.from("sonnet_prompt_decisions")
  .select("sonnet_prompt_id, decision, performed_by, created_at")
  .eq("workspace_id", workspaceId)
  .eq("source", "manual_override")
  .gte("created_at", since);
```

## Gotchas

- **`decision`** is what the system finally APPLIED, not necessarily what the model recommended. When the safety guards force `human_review` (confidence floor, daily cap, missing target), `reasoning` is prepended with `[SAFETY] ...` to explain why.
- **`confidence` is the model's raw value.** Even when forced to `human_review`, this stays untouched — so you can analyze how often the safety guards intervened.
- **Append-only.** Never UPDATE / DELETE rows. A human override on a previously-auto-decided prompt creates a NEW row with `source='manual_override'`.
- **`input_voice_doc_hashes`** lets a replay confirm the voice docs haven't drifted since the decision. If they have, the previous decision should probably be re-evaluated by the cron next run.
- **Cost accounting also goes through [[ai_token_usage]]** (separate row per call) — this table holds the per-decision audit; ai_token_usage holds the per-call meter.

## Related

[[sonnet_prompts]] · [[daily_analysis_reports]] · [[ticket_analyses]] · [[policies]] · [[ai_token_usage]] · [[../lifecycles/ai-learning]] · [[../lifecycles/ai-multi-turn]] · [[../inngest/sonnet-prompt-auto-review]]
