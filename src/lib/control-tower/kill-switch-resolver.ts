/**
 * Kill-switch cascade resolver (kill-switches-table-and-cascade-resolver P2) —
 * `resolveEffectiveSwitch(nodeId)` walks the canonical node registry parent→parent up to the
 * department seat, checking each ancestor against `public.kill_switches`. First hit wins:
 *
 *   { off: true, offBy: <ancestor_node_id>, scope: <ancestor_scope> }   // an ancestor is OFF
 *   { off: false }                                                       // the whole chain is clear
 *
 * **Fail-open by construction.** A missing row means the node is ON — mirrors
 * [[../agents/approval-router]] `loadAutonomyMap`'s "missing row ⇒ off" fail-safe on the opposite
 * polarity. An unconfigured registry never silently switches a node off; the CEO must explicitly
 * write a row for the switch to take effect.
 *
 * **Cascades DOWN, never UP.** A `dept:growth` row switches every growth-owned director / agent /
 * tool off; a leaf-only row (e.g. a single MONITORED_LOOPS cron) does not affect its parent or
 * a sibling. The walk starts at the query node and STOPS at the first ancestor that has a row;
 * a leaf's own row is honored (it is its own first ancestor).
 *
 * **Sibling isolation.** A `director:growth` row does not affect `director:cs` — the walk goes UP,
 * not sideways. The verification suite pins this invariant.
 *
 * **Node-id normalization.** The caller may pass either a canonical registry id (`dept:growth`,
 * `director:cs`, `agent:media-buyer`, `media-buyer-cadence-cron`) or a raw agent-kind slug
 * (`media-buyer`, `build`). Both resolve, so approval-inbox / agent-grader / model-tier-proposals
 * callers don't need to translate to the canonical id before consulting the switch.
 *
 * **Department-key convenience.** The kill_switches row for a department is keyed by the FUNCTION
 * SLUG (e.g. `'growth'`), not the canonical registry id (`'dept:growth'`) — the CEO cockpit surfaces
 * a department as its function slug (matching [[../tables/function_autonomy]]'s convention). The
 * walk therefore checks BOTH candidate keys at a department node: the canonical id AND the bare
 * function slug. Either stored form is honored.
 *
 * **TTL cache.** `resolveEffectiveSwitch` uses a small module-level TTL cache (30s) so a batch scan
 * or a burst of enqueue-guards doesn't hammer the DB. `resolveEffectiveSwitchMany` (the M5 orphan
 * audit's batched read) loads the map once and walks every node against the same snapshot for
 * consistent within-batch answers. `invalidateKillSwitchCache()` is exported so the Phase 3 POST
 * route can bust the cache immediately after a toggle write, giving the CEO's next read a fresh view.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { createAdminClient as makeAdminClient } from "@/lib/supabase/admin";
import { getNode, resolveNodeOwner, type OrgNode } from "@/lib/control-tower/node-registry";

type Admin = ReturnType<typeof createAdminClient>;

/** The scope of the OFFENDING ancestor (mirrors the CHECK constraint on `public.kill_switches.scope`). */
export type KillSwitchScope = "department" | "director" | "agent" | "tool";

/** One row of public.kill_switches. */
export interface KillSwitchRow {
  node_id: string;
  scope: KillSwitchScope;
  off_by: string;
  off_at: string;
  reason: string | null;
}

/** The resolved effective switch for a node — off with attribution, or clear. */
export type EffectiveSwitch =
  | { off: true; offBy: string; scope: KillSwitchScope; reason: string | null }
  | { off: false };

/** In-memory snapshot of `public.kill_switches` (keyed by stored `node_id`). */
export type KillSwitchMap = ReadonlyMap<string, KillSwitchRow>;

const EMPTY_MAP: KillSwitchMap = new Map();

/** TTL for the module-level cache — small enough that a toggle takes effect within one Control
 * Tower tick, large enough to soak an enqueue-burst without hitting the pooler on every call. */
const CACHE_TTL_MS = 30_000;

type CacheEntry = { at: number; map: KillSwitchMap };
let cache: CacheEntry | null = null;

/**
 * Load `public.kill_switches` into a Map keyed by stored `node_id`. On any DB error or a null
 * dataset, returns an EMPTY map — fail-open (the ON default) so a transient pooler blip never
 * silently switches every node off. Mirrors [[../agents/approval-router]] `loadAutonomyMap`.
 */
export async function loadKillSwitchMap(admin?: Admin): Promise<KillSwitchMap> {
  const client = admin ?? makeAdminClient();
  const { data, error } = await client
    .from("kill_switches")
    .select("node_id, scope, off_by, off_at, reason");
  if (error || !data) return EMPTY_MAP;
  const map = new Map<string, KillSwitchRow>();
  for (const row of data as KillSwitchRow[]) map.set(row.node_id, row);
  return map;
}

/** Bust the module-level cache — called by the Phase 3 POST route after a write. */
export function invalidateKillSwitchCache(): void {
  cache = null;
}

/** Get the current cached map or refresh from the DB. Also exposed for the M5 batched read. */
async function getCachedMap(): Promise<KillSwitchMap> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;
  const map = await loadKillSwitchMap();
  cache = { at: now, map };
  return map;
}

/**
 * Resolve the canonical `OrgNode` for a caller-provided id. Accepts a raw agent-kind slug OR the
 * registry's canonical id — same normalization contract as `resolveNodeOwner`. Returns null when
 * the id is genuinely unknown (a Phase-3-guarded write shouldn't produce this, but the resolver
 * degrades gracefully — an unknown node is treated as ON).
 */
function resolveOrgNode(nodeId: string): OrgNode | null {
  const direct = getNode(nodeId);
  if (direct) return direct;
  // The `resolveNodeOwner` slug forms also apply here — try `agent-kind:<slug>` and `agent:<slug>`.
  const asAgentKind = getNode(`agent-kind:${nodeId}`);
  if (asAgentKind) return asAgentKind;
  const asMonitored = getNode(`agent:${nodeId}`);
  if (asMonitored) return asMonitored;
  return null;
}

/**
 * ad-creative-box-session-only-retire-deterministic-path Phase 3 (2026-07-19) — extract the bare
 * agent-kind slug from an agent-node id. Agent nodes carry one of two id forms:
 *   - `agent:<slug>`     — MONITORED_LOOPS agent-kind rows (e.g. `agent:ad-creative`)
 *   - `agent-kind:<slug>` — KIND_OWNER_FALLBACK synthetic nodes (e.g. `agent-kind:fold`)
 * Returns the bare slug, or null when the id does not carry either prefix (defensive; the caller
 * still checks `node.kind === "agent"` upstream).
 */
function bareAgentSlugForNode(node: OrgNode): string | null {
  if (node.kind !== "agent") return null;
  if (node.id.startsWith("agent:")) return node.id.slice("agent:".length);
  if (node.id.startsWith("agent-kind:")) return node.id.slice("agent-kind:".length);
  return null;
}

/**
 * Walk the ancestor chain starting at `node` up to (and including) the root department, checking
 * each ancestor against the map. Returns the FIRST hit — the OFFENDING ancestor — or null if the
 * chain is clear.
 *
 * At a department node, both stored key forms are honored: the canonical id (`dept:growth`) AND
 * the bare function slug (`growth`, matching [[../tables/function_autonomy]] convention).
 *
 * At an agent-kind node, the bare agent-kind slug is ALSO honored alongside the canonical
 * `agent:<slug>` / `agent-kind:<slug>` id — mirrors the department-key convenience above and
 * closes the 2026-07-19 gap where a `kill_switches.node_id='ad-creative'` row failed to suppress
 * an `agent:ad-creative` claim (ad-creative-box-session-only-retire-deterministic-path Phase 3).
 */
function findOffendingAncestor(node: OrgNode, map: KillSwitchMap): KillSwitchRow | null {
  const seen = new Set<string>();
  let cursor: OrgNode | null = node;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    // Direct check by canonical id.
    const direct = map.get(cursor.id);
    if (direct) return direct;
    // Department-key convenience: also check the bare function slug.
    if (cursor.kind === "department") {
      const bySlug = map.get(cursor.owner);
      if (bySlug) return bySlug;
    }
    // Agent-kind bare-slug convenience: honor a kill_switches row keyed by the bare agent-kind
    // slug (`ad-creative`) alongside the canonical `agent:ad-creative` / `agent-kind:<slug>` id.
    if (cursor.kind === "agent") {
      const bareSlug = bareAgentSlugForNode(cursor);
      if (bareSlug) {
        const byAgentSlug = map.get(bareSlug);
        if (byAgentSlug) return byAgentSlug;
      }
    }
    // Step up. A root department has parent=null → loop exits.
    if (!cursor.parent) break;
    cursor = getNode(cursor.parent);
  }
  return null;
}

/**
 * Walk the registry parent→parent from `nodeId` (or its normalized OrgNode), returning the first
 * ancestor that has a `kill_switches` row. Uses the pre-loaded `map` — pure, deterministic, and
 * unit-testable in isolation.
 *
 * A caller with an unknown `nodeId` gets `{ off: false }` — an unregistered node is treated as
 * ON (fail-open); the registry drift check is the durable fix for that surface, not this resolver.
 */
export function resolveEffectiveSwitchFromMap(
  nodeId: string,
  map: KillSwitchMap,
): EffectiveSwitch {
  const node = resolveOrgNode(nodeId);
  if (!node) return { off: false };
  const hit = findOffendingAncestor(node, map);
  if (!hit) return { off: false };
  return { off: true, offBy: hit.node_id, scope: hit.scope, reason: hit.reason };
}

/**
 * Live one-shot resolution — reads the module-level TTL-cached map and walks the ancestor chain.
 * Use from a route handler / enqueue-guard where a per-call snapshot is fine. For a batch scan,
 * prefer `resolveEffectiveSwitchMany` so every id in the batch reads the same snapshot.
 */
export async function resolveEffectiveSwitch(nodeId: string): Promise<EffectiveSwitch> {
  const map = await getCachedMap();
  return resolveEffectiveSwitchFromMap(nodeId, map);
}

/**
 * Batched resolution for the M5 orphan-node audit — loads `public.kill_switches` ONCE and walks
 * every input node against the same snapshot. Consistent within-batch answers (no read-skew if a
 * write lands mid-scan). Returns a `Map<nodeId, EffectiveSwitch>` keyed by the caller's input id.
 */
export async function resolveEffectiveSwitchMany(
  nodeIds: readonly string[],
): Promise<Map<string, EffectiveSwitch>> {
  const out = new Map<string, EffectiveSwitch>();
  if (nodeIds.length === 0) return out;
  const map = await getCachedMap();
  for (const nodeId of nodeIds) out.set(nodeId, resolveEffectiveSwitchFromMap(nodeId, map));
  return out;
}

// Re-export the registry lookup so consumers of this module don't have to import from both files
// when they just need "is X off / who owns X" — the two questions travel together.
export { resolveNodeOwner };
