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
- **`POST /api/developer/control-tower/switch`** ([src/app/api/developer/control-tower/switch/route.ts](../../../src/app/api/developer/control-tower/switch/route.ts)) — the CEO-only writer ([[../specs/a-kill-switch-can-always-be-turned-back-on]] Phase 1). Owner-gated (mirrors the sibling `/api/developer/control-tower/*` routes — `workspace_members.role='owner'`), validates `node_id` through [[../libraries/control-tower-node-registry|resolveNodeOwner]] + slug variants (rejects an unknown node with 400 — the table's `NODE MUST EXIST IN THE REGISTRY` invariant), and calls `invalidateKillSwitchCache()` after every write so the toggle takes effect within one tick. Body `{ node_id, off, reason? }`. On `off=true` UPSERTs on `node_id` (scope mirrored from the registry — `cron`/`reactive` bucket to `tool`, `inline-agent` to `agent`); on `off=false` DELETEs the row (MISSING ROW ⇒ ON per the fail-open invariant — clearing is a delete, NOT a flag flip), deleting both the canonical id AND the caller's raw input so a legacy row stored under the bare slug (like the `ad-creative` freeze that lingered 2026-07-15 → 2026-08-18) cannot survive on the other key. Records a [[director_activity]] row with `action_kind='kill_switch_toggle'` for BOTH set AND clear — the DELETE leaves nothing behind, so the ledger is the only surviving record of who lifted a freeze.
- **`scripts/_check-kill-switch-writer.ts`** ([[../specs/a-kill-switch-can-always-be-turned-back-on]] Phase 2) — the build-time guard that keeps the claim above honest. Two assertions per `predeploy` run: (a) the sanctioned route file EXISTS and exports a POST handler (deleting the route fails CI with a named offender — the exact drift that let the ad-creative freeze survive a month); (b) no OTHER `.ts`/`.tsx` under `src/`+`scripts/` performs an insert/update/upsert/delete against `public.kill_switches` (a second writer re-opens the CEO-only hole). Legitimate second callers can be added to `WRITE_ALLOWLIST` with a written justification — the guard is tightened, never deleted, when it first fires. Wired into `check:kill-switch-writer` in the `predeploy:static` chain.

## Migration

`supabase/migrations/20261013000000_kill_switches.sql` (apply: `npx tsx scripts/apply-kill-switches-migration.ts`). Idempotent — `create table if not exists` + RLS policies (drop-if-exists then create). Seeded **empty** on purpose — an unconfigured registry never silently switches a node off. Follow-up: `supabase/migrations/20261016000000_lock_kill_switches_service_role_only.sql` (apply: `npx tsx scripts/apply-lock-kill-switches-service-role-only.ts`) drops the broad `_select to authenticated` policy so only the `_service` policy grants direct table access.

## Related

[[../specs/kill-switches-table-and-cascade-resolver]] · [[../libraries/control-tower-node-registry]] — the canonical org tree the resolver walks · [[../libraries/kill-switch-resolver]] (Phase 2) · [[function_autonomy]] — sibling primitive on the opposite polarity (fail-off vs this table's fail-on) · [[../libraries/control-tower-self-audit]] · [[../goals/ceo-org-control-tower]] · [[../operational-rules]] (§ North star — supervisable autonomy)
