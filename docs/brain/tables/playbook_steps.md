# playbook_steps

Steps inside a playbook — ordered, with action type and config. See [[../playbooks/README]].

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `playbook_id` | `uuid` | — | → [[playbooks]].id |
| `step_order` | `int4` | — | default: `0` |
| `type` | `text` | — |  |
| `name` | `text` | — |  |
| `instructions` | `text` | ✓ |  |
| `data_access` | `text[]` | — | default: `'{}'` |
| `resolved_condition` | `text` | ✓ |  |
| `config` | `jsonb` | — | default: `'{}'` |
| `skippable` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `playbook_id` → [[playbooks]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("playbook_steps")
  .select("id, name, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("playbook_steps")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **`type` is bounded by a CHECK constraint** — the current allow-set (as of migration `20260707150000_seed_assisted_purchase_playbook.sql`) is: `identify_order`, `identify_subscription`, `check_other_subscriptions`, `apply_policy`, `offer_exception`, `initiate_return`, `cancel_subscription`, `issue_store_credit`, `stand_firm`, `explain`, `custom`, `clarify_issue`, `check_tracking`, `classify_issue`, `select_missing_items`, `confirm_shipping_address`, `create_replacement`, `adjust_subscription`, `check_vaulted_pm`, `create_order`, `create_subscription`. Adding a new step type requires an additive migration that drops+recreates the constraint (retain existing entries so live playbooks keep validating).

- **`check_vaulted_pm` + terminal `create_order` / `create_subscription` are the [[../specs/assisted-purchase-playbook]] Phase-2 step pair.** Seeded per workspace into the "Assisted Order Purchase" / "Assisted Subscription Purchase" playbooks; see [[playbook-executor]] Gotchas.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
