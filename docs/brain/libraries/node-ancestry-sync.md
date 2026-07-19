# node-ancestry-sync

`src/lib/control-tower/node-ancestry-sync.ts` — mirrors the [[control-tower-node-registry|canonical node registry]] (which lives in TypeScript) into [[../tables/node_ancestry]] so `public.claim_agent_job` can walk ancestors in SQL. The DB-side half of the kill-switch cascade ([[../specs/claim-rpc-kill-switch-enforcement]] Phase 1).

## Exports

- **`computeNodeAncestryRows(): NodeAncestryRow[]`** — pure, deterministic. Iterates `MONITORED_LOOPS` and `BUILDER_WORKER_KINDS` from [[control-tower-node-registry]], resolves each to an `OrgNode`, walks `getParent` up to the department seat and returns one row per unique `agent_jobs.kind` with `{ node_id, kind, ancestors }`. Every department in `ancestors[]` is appended twice — as the canonical `dept:<fn>` id AND as the bare `<fn>` slug — so a `kill_switches` row stored under either form matches (mirrors the department-key convenience in [[kill-switch-resolver]]).
- **`syncNodeAncestry(admin?): Promise<NodeAncestrySyncResult>`** — the WRITER. Upserts every row from `computeNodeAncestryRows()` into `public.node_ancestry` on conflict `node_id`, then reads back the current key set and deletes any stale rows the registry no longer covers. Idempotent — a re-run over an in-sync mirror is a no-op. Returns `{ ok, upserted, deleted, detail }` — a Supabase error returns `ok:false` with the message; the caller (box-worker startup + the Inngest cron) logs and continues. A failed sync is not a live outage because the RPC is fail-open.

## Types

- `NodeAncestryRow` — `{ node_id: string; kind: string; ancestors: string[] }`.
- `NodeAncestrySyncResult` — `{ ok: boolean; upserted: number; deleted: number; detail: string }`.

## Callers

- **`scripts/builder-worker.ts`** — on startup, imports and calls `syncNodeAncestry()` fire-and-forget alongside `syncInngestRegistration()`. Best-effort; never blocks the worker loop.
- **[[../inngest/node-ancestry-sync-cron]]** — nightly Inngest cron (`15 3 * * *`) that reruns the sync as a backstop for the edge case where the box has stayed up across a registry change.
- **`scripts/sync-node-ancestry.ts`** — one-shot CLI wrapper (manual deploy hook / debugging).

## Invariants

- **REGISTRY IS SOURCE OF TRUTH.** The desired state is derived from `NODES` in [[control-tower-node-registry]] every call. Adding a new agent-kind slug to `KIND_OWNER_FALLBACK` or a new `agent-kind` MONITORED_LOOPS row automatically populates a new `node_ancestry` row on the next sync.
- **BARE FUNCTION SLUG AT DEPARTMENT LEVEL.** `ancestorsFor(node)` appends both `dept:growth` AND `growth` (the bare slug) when walking through a department node, so a `kill_switches` row keyed by either form is honored.
- **AGENT-KIND BARE-SLUG SELF-ALIAS (ad-creative-box-session-only-retire-deterministic-path Phase 3 — 2026-07-19).** `computeNodeAncestryRows` prepends the row's bare `kind` slug to `ancestors[]` via the pure `withKindAlias(ancestors, kindSlug, canonicalNodeId)` helper whenever the slug differs from `node_id` (i.e. every agent-kind row — `agent:ad-creative` vs `ad-creative`, `agent-kind:fold` vs `fold`). The bare slug names the SAME node as `node_id` — treating it as a self-alias inside `ancestors[]` lets `public.claim_agent_job`'s ancestor join match a `kill_switches.node_id='<slug>'` row without any schema change. Mirrors the [[kill-switch-resolver]] `findOffendingAncestor` agent-kind bare-slug convenience introduced in the same phase, so the DB-side and TS-side cascades stay symmetric. Closes the 2026-07-19 gap where a `kill_switches.node_id='ad-creative'` row failed to suppress `agent:ad-creative` claims and the daily cadence produced un-graded exploit ads despite a frozen switch. `withKindAlias` is deduped + no-op-when-slug-equals-node-id, so a re-import returns the same rows (mirror sync stays idempotent).
- **FAIL-OPEN.** A missing / empty mirror means `public.claim_agent_job` sees no ancestry rows for a kind and the `not exists` guard degrades to true (claim proceeds). A drift is not a live outage — it just means a newly-registered kind is not yet gated by the switch.

## Related

[[../specs/claim-rpc-kill-switch-enforcement]] · [[../tables/node_ancestry]] · [[control-tower-node-registry]] · [[kill-switch-resolver]] · [[../tables/kill_switches]] · [[../inngest/node-ancestry-sync-cron]]
