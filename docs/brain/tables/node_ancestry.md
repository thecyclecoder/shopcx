# node_ancestry

DB mirror of the [[../libraries/control-tower-node-registry|canonical node registry]] — one row per `agent_jobs.kind` with its `node_id` + the parent → parent chain up to the root department. The DB primitive that gates `public.claim_agent_job` on the [[kill_switches]] cascade ([[../specs/claim-rpc-kill-switch-enforcement]] Phase 1).

**Why this exists.** The registry lives in TypeScript (source of truth). `resolveEffectiveSwitch` walks it in TS space. But `public.claim_agent_job` — the box's central chokepoint — runs in the DB and can't call TS. This table is the DB-side ancestor walk: `kind_to_node_id(agent_jobs.kind)` selects the row for the queued kind, and the RPC's `not exists` guard rejects the row if any element of its `node_id + ancestors[]` has an open `kill_switches` row. One DB primitive gates every box lane centrally — no app-code changes when the CEO toggles a switch.

**Fail-open by construction.** A missing / empty mirror means every kind claims normally (the `not exists` degrades to `true`). See `syncNodeAncestry` in [[../libraries/node-ancestry-sync]] for the invariant.

**GLOBAL config — not workspace-scoped.** The canonical org tree is ShopCX's own DevOps org, singular; there is no `workspace_id`. Read + written via the service role; the box worker + the [[../inngest/node-ancestry-sync-cron]] Inngest cron are the only writers.

**Primary key:** `node_id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `node_id` | `text` | PK · canonical node id from [[../libraries/control-tower-node-registry]] `resolveNodeOwner` (e.g. `agent:media-buyer`, `agent-kind:build`). |
| `kind` | `text` | the `agent_jobs.kind` slug this node handles. Uniquely selects the node in `public.kind_to_node_id`. Indexed. |
| `ancestors` | `text[]` | parent → parent walk up to the root department, PLUS the bare function slug at the department level (`growth`, not just `dept:growth`) so a `kill_switches` row stored under either form is honored. GIN-indexed. |

## Invariants

- **MISSING ROW ⇒ FAIL-OPEN.** An unregistered kind (no row) claims normally — the RPC's `not exists` returns true. The sync is idempotent; a stale drift is not a live outage.
- **BARE SLUG AT DEPARTMENT LEVEL.** `ancestors[]` includes BOTH the canonical `dept:<fn>` id AND the bare `<fn>` slug so a `kill_switches` row keyed by either form matches — mirrors the department-key convenience in [[../libraries/kill-switch-resolver]] `findOffendingAncestor`.
- **REGISTRY IS SOURCE OF TRUTH.** Every row is derived from `src/lib/control-tower/node-registry.ts`. A row that no longer appears in the registry is deleted on the next sync (the stale-sweep step in [[../libraries/node-ancestry-sync]] `syncNodeAncestry`).

## Readers / writers

- **`public.claim_agent_job(p_kinds)`** — reads via `kind_to_node_id(agent_jobs.kind)` in a `not exists` subquery against `kill_switches`. The box's central chokepoint; every lane routes through here.
- **`public.claim_agent_job_diag(p_kinds)`** — jsonb peek returning up to 20 queued rows whose claim would have been suppressed, with `{ agent_job_id, kind, suppressed_by, scope }`. Read by `scripts/builder-worker.ts` on a null claim so the Control Tower tile can show "off by \<ancestor\>" instead of a silent idle (Phase 2).
- **`public.kind_to_node_id(k)`** — helper stable SQL fn that resolves a kind to its node id via this table.
- **`syncNodeAncestry`** ([[../libraries/node-ancestry-sync]]) — the ONLY writer. Called by the box worker on startup (mirroring `syncInngestRegistration`) + nightly by [[../inngest/node-ancestry-sync-cron]] as a backstop.

## Migration

`supabase/migrations/20261014000000_kill_switch_enforce_claim.sql`. Idempotent — `create table if not exists`, RLS policies (`drop policy if exists` then `create`), `create or replace function` for `kind_to_node_id`, `claim_agent_job`, `claim_agent_job_diag`. Seeded **empty** on apply; the box worker populates it on next startup.

## Related

[[../specs/claim-rpc-kill-switch-enforcement]] · [[kill_switches]] · [[agent_jobs]] · [[../libraries/control-tower-node-registry]] · [[../libraries/kill-switch-resolver]] · [[../libraries/node-ancestry-sync]] · [[../inngest/node-ancestry-sync-cron]] · [[../goals/ceo-org-control-tower]]
