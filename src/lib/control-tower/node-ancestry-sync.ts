/**
 * node-ancestry-sync (claim-rpc-kill-switch-enforcement Phase 1) — mirrors the canonical node
 * registry (`src/lib/control-tower/node-registry.ts`) into `public.node_ancestry` so
 * `public.claim_agent_job` can walk ancestors in SQL and reject a queued row whose kind's node
 * (or any ancestor) has an open `public.kill_switches` row.
 *
 * The registry lives in TypeScript (code is source of truth). This module recomputes the mirror
 * from the FROZEN `NODES` graph — one row per agent_jobs.kind with:
 *   - `node_id`: the node handling that kind (MONITORED_LOOPS.id for an agent-kind row, or
 *     `agent-kind:<slug>` for a builder-worker kind that lives in KIND_OWNER_FALLBACK).
 *   - `kind`: the agent_jobs.kind slug (unique across the mirror — `kind_to_node_id` selects by
 *     this column).
 *   - `ancestors[]`: the parent → parent walk up to the root department, PLUS the bare function
 *     slug at the department level (mirrors the department-key convenience in
 *     [[./kill-switch-resolver]] — a kill_switches row keyed by `'growth'` matches even though
 *     the canonical id is `dept:growth`).
 *
 * The `syncNodeAncestry` upsert is idempotent: a re-import returns the same rows, and a re-run
 * after a registry change picks up the delta. The box worker runs it on startup (mirroring
 * `syncInngestRegistration`) so the deploy-time trigger keeps the mirror aligned; the
 * `node-ancestry-sync-cron` Inngest cron reruns it nightly as a backstop.
 *
 * Fail-open by construction — a missing / empty mirror means every kind claims normally (the
 * `not exists` guard in `claim_agent_job` degrades to true). See the table comment on
 * `public.node_ancestry` for the invariant.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { createAdminClient as makeAdminClient } from "@/lib/supabase/admin";
import {
  NODES,
  getNode,
  BUILDER_WORKER_KINDS,
  type OrgNode,
} from "@/lib/control-tower/node-registry";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";

type Admin = ReturnType<typeof createAdminClient>;

/** One row of `public.node_ancestry`. */
export interface NodeAncestryRow {
  node_id: string;
  kind: string;
  ancestors: string[];
}

/** The result of a sync — how many rows we upserted / deleted / found in error. */
export interface NodeAncestrySyncResult {
  ok: boolean;
  upserted: number;
  deleted: number;
  detail: string;
}

/**
 * Walk the ancestor chain from `node` up to (and including) the root department, then append
 * the bare function slug at the department level (so a kill_switches row keyed by either the
 * canonical `dept:<fn>` id OR the bare `<fn>` slug is honored — same convention as
 * `findOffendingAncestor` in [[./kill-switch-resolver]]).
 */
function ancestorsFor(node: OrgNode): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: OrgNode | null = node.parent ? getNode(node.parent) : null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor.id);
    if (cursor.kind === "department") {
      // Department-key convenience: also expose the bare function slug so a stored `'growth'`
      // row matches without normalizing to `'dept:growth'`.
      if (cursor.owner !== cursor.id) chain.push(cursor.owner);
    }
    if (!cursor.parent) break;
    cursor = getNode(cursor.parent);
  }
  return chain;
}

/**
 * ad-creative-box-session-only-retire-deterministic-path Phase 3 (2026-07-19) —
 * **agent-kind bare-slug alias.** For an agent-kind mirror row we ALSO expose the bare
 * agent-kind slug in `ancestors[]` (a self-alias — the slug names the same node as
 * `node_id`). This mirrors the department-key convenience already in `ancestorsFor` and
 * closes the gap that let a `kill_switches.node_id='ad-creative'` row (the bare slug — the
 * form the CEO cockpit surfaces) fail to match `agent:ad-creative` in
 * `public.claim_agent_job`'s ancestor join on 2026-07-19. Deduped, always leading — a
 * row's `ancestors[]` therefore ALWAYS contains its own `kind` as the first element.
 */
function withKindAlias(ancestors: string[], kindSlug: string, canonicalNodeId: string): string[] {
  if (kindSlug === canonicalNodeId) return ancestors; // no alias needed (canonical id === slug)
  if (ancestors.includes(kindSlug)) return ancestors; // already covered
  return [kindSlug, ...ancestors];
}

/**
 * Compute the desired mirror from the frozen `NODES` graph — one row per agent_jobs.kind. Two
 * sources:
 *   1) Every `MONITORED_LOOPS` row with an `agentKind` — the node's id is a real MONITORED_LOOPS
 *      id (e.g. `agent:media-buyer` or a reactive whose id differs from its agentKind).
 *   2) Every `BUILDER_WORKER_KINDS` entry not already in (1) — these live under
 *      `agent-kind:<kind>` synthetic ids in the registry (KIND_OWNER_FALLBACK). Skip a kind that
 *      does not resolve to any node — the caller is expected to keep KIND_OWNER_FALLBACK in
 *      sync (`_check-node-registry-drift.ts` catches drift at CI time).
 *
 * Each row's `ancestors[]` carries the bare agent-kind slug as a self-alias (see `withKindAlias`)
 * so a `kill_switches` row keyed by the bare slug matches `public.claim_agent_job`'s ancestor
 * join alongside the canonical `node_id`.
 */
export function computeNodeAncestryRows(): NodeAncestryRow[] {
  const rows = new Map<string, NodeAncestryRow>(); // keyed by kind (unique)

  // Source 1: MONITORED_LOOPS agent-kind rows.
  for (const loop of MONITORED_LOOPS) {
    if (!loop.agentKind) continue;
    const node = getNode(loop.id);
    if (!node) continue;
    rows.set(loop.agentKind, {
      node_id: node.id,
      kind: loop.agentKind,
      ancestors: withKindAlias(ancestorsFor(node), loop.agentKind, node.id),
    });
  }

  // Source 2: builder-worker kinds not already covered — the KIND_OWNER_FALLBACK entries the
  // node-registry emits as `agent-kind:<slug>`.
  for (const kind of BUILDER_WORKER_KINDS) {
    if (rows.has(kind)) continue;
    // The registry uses `agent-kind:<slug>` for these; fall back to `<slug>` if a future entry
    // is declared as a MONITORED_LOOPS row keyed by the bare slug.
    const node = getNode(`agent-kind:${kind}`) ?? getNode(kind);
    if (!node) continue;
    rows.set(kind, {
      node_id: node.id,
      kind,
      ancestors: withKindAlias(ancestorsFor(node), kind, node.id),
    });
  }

  return Array.from(rows.values());
}

/**
 * Upsert every row from `computeNodeAncestryRows()` into `public.node_ancestry` and delete any
 * stale rows the registry no longer covers. Idempotent — a re-run over an already-in-sync mirror
 * is a no-op.
 *
 * Best-effort by design — a Supabase error returns `ok:false` with a `detail` so a caller
 * (box-worker startup + the Inngest cron) can log and continue. A failed sync must never crash
 * the caller: the claim RPC is fail-open, so an out-of-date mirror is not a live outage.
 */
export async function syncNodeAncestry(admin?: Admin): Promise<NodeAncestrySyncResult> {
  const client = admin ?? makeAdminClient();
  const desired = computeNodeAncestryRows();
  const desiredKinds = new Set(desired.map((r) => r.kind));

  // Upsert every desired row (on conflict on node_id — the PK).
  const { error: upsertErr } = await client
    .from("node_ancestry")
    .upsert(desired, { onConflict: "node_id" });
  if (upsertErr) {
    return {
      ok: false,
      upserted: 0,
      deleted: 0,
      detail: `node-ancestry upsert failed: ${upsertErr.message}`,
    };
  }

  // Delete any stale rows that no longer appear in the registry (a builder-worker kind was
  // removed, a MONITORED_LOOPS row was renamed). Read the current keys and diff.
  const { data: current, error: readErr } = await client
    .from("node_ancestry")
    .select("kind");
  if (readErr || !current) {
    return {
      ok: true,
      upserted: desired.length,
      deleted: 0,
      detail: `node-ancestry upsert ok (${desired.length}); stale-sweep skipped: ${readErr?.message ?? "no rows"}`,
    };
  }
  const stale = (current as { kind: string }[]).filter((r) => !desiredKinds.has(r.kind)).map((r) => r.kind);
  let deleted = 0;
  if (stale.length > 0) {
    const { error: delErr, count } = await client
      .from("node_ancestry")
      .delete({ count: "exact" })
      .in("kind", stale);
    if (delErr) {
      return {
        ok: true,
        upserted: desired.length,
        deleted: 0,
        detail: `node-ancestry upsert ok (${desired.length}); stale-sweep failed: ${delErr.message}`,
      };
    }
    deleted = count ?? stale.length;
  }

  return {
    ok: true,
    upserted: desired.length,
    deleted,
    detail: `node-ancestry sync ok (upserted ${desired.length}, deleted ${deleted})`,
  };
}
