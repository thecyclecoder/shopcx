# kill_switches

The **universal on/off primitive** behind the CEO Control Tower's kill switch ([[../specs/kill-switches-table-and-cascade-resolver]] Phase 1) — one row per canonical node the CEO has explicitly turned **off**. The [[../libraries/control-tower-node-registry|canonical org tree]] declares WHICH nodes exist; this table declares which ones are OFF. Everything else is ON.

**MISSING ROW ⇒ ON.** An unconfigured registry never silently switches a node off — fail-open by construction, mirrors [[function_autonomy]]'s "missing row ⇒ off" fail-safe on the opposite polarity. The Phase 2 [[../libraries/kill-switch-resolver|resolveEffectiveSwitch]] cascade walks the registry parent→parent so an ancestor-off row cascades down: turning `growth` off in one write stops every `growth`-owned director / agent / tool within one Control Tower tick. The success metric of the CEO Control Tower goal ([[../goals/ceo-org-control-tower]] M2) rests on this table.

**GLOBAL config — not workspace-scoped.** The org chart is ShopCX's own internal DevOps org, singular, so there is no `workspace_id`; `node_id` is the PK. Read + written via the service role; the Phase 3 `POST /api/developer/control-tower/switch` route is the **only writer** and gates on the CEO seat above the DB. **RLS: service_role only** — direct `.from('kill_switches')` from an authenticated (non-service) session returns zero rows. The `_select to authenticated` policy shipped in the Phase 1 migration was dropped by `supabase/migrations/20261016000000_lock_kill_switches_service_role_only.sql` ([[../specs/monitor-cadence-scaled-liveness-window]] Phase 3 Fix 1) because `off_by` (audit trail) and free-text `reason` should not be visible to every authenticated session. A dashboard that needs switch state must go through the owner-gated Control Tower switch route, never a client-side table read.

**Primary key:** `node_id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `node_id` | `text` | PK · the canonical node id from [[../libraries/control-tower-node-registry]] `resolveNodeOwner` (e.g. `growth`, `director:platform`, `agent-kind:build`, `box`). Validated by the Phase 3 route against the registry — a row can only exist for a known node. |
| `scope` | `text` | one of `department` / `director` / `agent` / `tool` — the node's scope in the canonical tree, mirrored from the registry at write time so a reader can classify without re-walking. CHECK-constrained. |
| `off_by` | `text` | the `workspace_members.display_name` (or system actor, e.g. `ceo`) that flipped this node off — audit trail. |
| `off_at` | `timestamptz` | when the flip happened · default `now()` |
| `reason` | `text?` | optional free-text note from the CEO explaining why this node is off |

## Invariants

- **MISSING ROW ⇒ ON.** A node with no row is ON — fail-open. The [[../libraries/kill-switch-resolver]] never invents a switch; it only reports what the table says.
- **CASCADES DOWN, NEVER UP.** A department-off row switches every descendant off; a leaf-off row does not affect the parent. The Phase 2 resolver walks parent→parent and returns the FIRST hit's `{ offBy, scope }`.
- **CEO-ONLY WRITER.** The Phase 3 route gates on the CEO seat before touching this table. Nothing else — no director, no worker, no cron — writes here.
- **NODE MUST EXIST IN THE REGISTRY.** The Phase 3 route rejects a `node_id` that `resolveNodeOwner` doesn't know. A stale row (registry entry deleted) is a drift bug caught by the M5 orphan audit; the table itself doesn't self-clean.

## Readers / writers

- **`resolveEffectiveSwitch(nodeId)`** ([[../libraries/kill-switch-resolver]]) — Phase 2 · loads all rows once per snapshot into an in-memory `Set<node_id>` (small TTL cache since Control Tower snapshots run every 5 min per the M4 tick floor), walks the [[../libraries/control-tower-node-registry|canonical registry]] parent→parent up to the department, returns `{ off: true, offBy, scope }` on the first hit or `{ off: false }` if the chain is clear. Companion `resolveEffectiveSwitchMany` for the M5 orphan audit's batched read.
- **`POST /api/developer/control-tower/switch`** — Phase 3 · CEO-only. Body `{ nodeId, off, reason? }`. On `off=true` upserts on conflict (node_id); on `off=false` deletes the row. Emits a [[director_activity]] row with `kind='kill_switch_toggle'` for the audit ledger.

## Migration

`supabase/migrations/20261013000000_kill_switches.sql` (apply: `npx tsx scripts/apply-kill-switches-migration.ts`). Idempotent — `create table if not exists` + RLS policies (drop-if-exists then create). Seeded **empty** on purpose — an unconfigured registry never silently switches a node off. Follow-up: `supabase/migrations/20261016000000_lock_kill_switches_service_role_only.sql` (apply: `npx tsx scripts/apply-lock-kill-switches-service-role-only.ts`) drops the broad `_select to authenticated` policy so only the `_service` policy grants direct table access.

## Related

[[../specs/kill-switches-table-and-cascade-resolver]] · [[../libraries/control-tower-node-registry]] — the canonical org tree the resolver walks · [[../libraries/kill-switch-resolver]] (Phase 2) · [[function_autonomy]] — sibling primitive on the opposite polarity (fail-off vs this table's fail-on) · [[../libraries/control-tower-self-audit]] · [[../goals/ceo-org-control-tower]] · [[../operational-rules]] (§ North star — supervisable autonomy)
