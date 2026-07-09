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
| `proposed_by` | `text` | ✓ | Provenance tag for AI-proposed playbooks awaiting human approval. `'playbook_compiler'` on a compiler seed ([[../libraries/playbook-compiler]] `applyBoxPlaybookCompile`, Phase 2 of [[../specs/playbook-compiler-becomes-box-agent-mining-full-history]]); cleared to null on approval by `approvePlaybookProposal`. `is_active=false AND proposed_by IS NOT NULL` = **Proposed**; `is_active=false AND proposed_by IS NULL` = **Retired** ([[../inngest/playbook-compiler]] retire path). |
| `source_tree_key` | `text` | ✓ | Pointer to [[compiled_trees]].`tree_key` for a compiler-seeded row; null for a human-authored playbook. Anchors idempotency — the partial `UNIQUE (workspace_id, source_tree_key) WHERE source_tree_key IS NOT NULL` index means a re-run of the compiler upserts the same seed, never a duplicate. |

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
- **Compiler seeds live in the Proposed lane.** [[../libraries/playbook-compiler]] `applyBoxPlaybookCompile` upserts one row per recurring [[compiled_trees]] tree with `is_active=false`, `proposed_by='playbook_compiler'`, and `source_tree_key=<tree_key>`. `matchPlaybook` / `matchPlaybookScored` filter by `is_active=true`, so a Proposed row is INVISIBLE to the runtime handler until a human approves via `approvePlaybookProposal` (which compare-and-sets on both `proposed_by` and `is_active` — a human-authored row can never be reflipped).
- **Compiler must NEVER insert an active playbook directly.** Enforced at CI by `scripts/_check-playbook-compiler-no-active.ts` (verified in the `playbook-compiler-becomes-box-agent-mining-full-history` Phase 2 verification bullet). A regression that lands `is_active=true` in the compiler's insert path fails the check red.
- **Sol reads approved compiler seeds as a distinct catalog** (Phase 3). [[../libraries/playbook-compiler]] `listApprovedCompiledPlaybooks` filters `is_active=true AND proposed_by IS NULL AND source_tree_key IS NOT NULL` — the DB-driven subset Sol's first-touch session flags as data-grounded in reasoning. Retiring (flipping `is_active=false`) removes the row from Sol's option set the next turn; no hardcoded list.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
