# compiled_trees

Durable store for the playbook-compiler box agent's recurring **problem × resolution TREES** — the substrate Phase 2 will read to propose data-grounded [[playbooks]] + [[playbook_steps]] (`is_active=false`).

**Primary key:** `id` · **Unique:** `(workspace_id, tree_key)` — anchors idempotency; a re-run of the box agent over unchanged history upserts the same row.

Phase 1 of [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]]: the compiler is no longer a raw-Anthropic-API cron drafting `sonnet_prompts`. A supervised box agent (kind `playbook-compile` in `scripts/builder-worker.ts` → `runPlaybookCompileJob`) reads the FULL history (tickets + `ticket_analyses`, no 30-day floor) and emits ONE JSON verdict listing trees; the deterministic worker upserts each verdict tree here via [[../libraries/playbook-compiler]] `applyBoxPlaybookCompile`.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · `ON DELETE CASCADE` |
| `tree_key` | `text` | — | Deterministic per-workspace key `<problem> :: <sorted-action_type>+…` — matches [[../libraries/playbook-compiler]] `treeKeyFor(problem, action_types)`. UNIQUE with `workspace_id`. |
| `problem` | `text` | — | Normalized diagnosis (lowercased, trimmed). |
| `action_types` | `text[]` | — | Sorted-unique action-shape tuple (e.g. `{partial_refund, replacement}`). Multi-action shapes stay together — Phase 2's playbook stays one row per tuple. |
| `support` | `int4` | — | Distinct ticket count backing this tree over the mining window. `support >= support_min` qualifies the tree for Phase 2 proposal (default 15, per-workspace override on `workspaces.playbook_compiler_support_min`). |
| `sample_ticket_ids` | `uuid[]` | — | Up to 20 sample ticket ids — audited in the CS director's activity feed + Phase 2's proposal UI. Default `'{}'`. |
| `intent_distribution` | `jsonb` | — | `{intent_name: distinct_ticket_count, …}` — the analyzer's real intent mix over the tree's tickets. Source Phase 2's `playbook.trigger_intents` is derived from. Default `{}`. |
| `resolution_sequence` | `jsonb` | — | Ordered list of action shapes the tree resolves via: `[{action_type, notes?}, …]`. Source Phase 2's `playbook_steps` rows are derived from. Default `[]`. |
| `evidence` | `jsonb` | — | Pointers back to source rows: `{resolution_event_ids, ticket_analyses_ids, window_start, window_end, …}`. Default `{}`. |
| `reasoning` | `text` | ✓ | Box agent's 1-2 sentence per-tree "why" — cited to real evidence. Copied verbatim into the CS director_activity `metadata.trees_reasoning` when Phase 2 lands. |
| `compiled_at` | `timestamptz` | — | Set to `now()` on every upsert — the last time the tree was re-affirmed by the agent. Default `now()`. |
| `compiled_by_job_id` | `uuid` | ✓ | → [[agent_jobs]].id — the `playbook-compile` job that produced the row. `ON DELETE SET NULL` so agent-jobs cleanup never loses trees. |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`
- `compiled_by_job_id` → [[agent_jobs]].`id`

**In (others → this):**

- [[playbooks]].`source_tree_key` — soft pointer (no formal FK — the partial UNIQUE `(workspace_id, source_tree_key) WHERE source_tree_key IS NOT NULL` on `playbooks` anchors idempotency). Each PROPOSED playbook the compiler seeds carries the source tree's key; approval leaves `source_tree_key` intact so Phase 3's Sol M4 selection can trace an approved playbook back to the tree that motivated it.

## Common queries

### Latest compiled trees for a workspace
```ts
const { data } = await admin.from("compiled_trees")
  .select("tree_key, problem, action_types, support, compiled_at, reasoning")
  .eq("workspace_id", workspaceId)
  .order("compiled_at", { ascending: false })
  .limit(50);
```

### Trees at-or-above a support threshold (Phase 2 candidates)
```ts
const { data } = await admin.from("compiled_trees")
  .select("*")
  .eq("workspace_id", workspaceId)
  .gte("support", supportMin)
  .order("support", { ascending: false });
```

### Idempotent upsert (the SDK's write chokepoint)
The only write path is [[../libraries/playbook-compiler]] `applyBoxPlaybookCompile` — it does an `.upsert({...}, { onConflict: "workspace_id,tree_key" })` per verdict tree. Never `.insert()` directly; the unique constraint would ERROR-on-conflict and the sweep would half-write.

## Gotchas

- **`tree_key` must equal `treeKeyFor(problem, action_types)`.** The runner defensively recomputes and normalizes an agent-emitted `tree_key`, but the store's UNIQUE constraint anchors on this — a mismatch is silently corrected only because the runner's normalizer fires first.
- **Multi-action shapes stay ONE tree.** A cluster like `{partial_refund, replacement}` is ONE row (sorted tuple); do NOT split it into two rows for the individual action types — Phase 2's playbook proposal is one-per-tuple.
- **Re-run is idempotent by design.** A `playbook-compile` job over unchanged history upserts the same rows with the same content + a fresh `compiled_at`; no fan-out, no duplicates.

## Related

- Parent spec: [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]] — Phase 1 lands this store, Phase 2 layers proposed `playbooks` + `playbook_steps`, Phase 3 wires the library into Sol's session selection.
- Writer: [[../libraries/playbook-compiler]] `applyBoxPlaybookCompile` — the only mutation chokepoint.
- Producer: [[../inngest/playbook-compiler]] (enqueuer) → `scripts/builder-worker.ts` `runPlaybookCompileJob` (the box lane).
- Audit: [[director_activity]] `action_kind='compiled_trees_extracted'` under `director_function='cs'`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
