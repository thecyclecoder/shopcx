/**
 * Control Tower — per-department Infra tab payload builder
 * ([[../../../docs/brain/specs/control-tower-infra-sub-page]] Phase 1).
 *
 * The CT's three global infra feeds — [[./error-feed]] (`error_events`),
 * [[./db-health]] (DB Health proposals + slow queries + top tables), and
 * [[./supabase-log-poll]] (Postgres/auth log incidents that land in `error_events` as
 * `source='supabase-logs'`) — are FLAT. A red rollup on a department can't be traced
 * down without hand-filtering N hundred rows. This module ancestry-filters each feed to
 * a single [[./registry]] `OwnerFunction` so the per-department Infra tab in the org
 * mirror surfaces ONLY the rows whose surface resolves under that department.
 *
 * `resolveErrorEventOwner(source, sample)` is the routing spine — it extracts a
 * `nodeId` candidate from the row's `sample` JSON and hands it to
 * [[./node-registry]] `resolveNodeOwner`. When the row's node resolves to an
 * `OwnerFunction`, that department owns the row; otherwise the row falls to
 * `platform` (the DB/infra default — matching where the ancestry falls off the tree
 * in `resolveNodeOwnerOrOrphanDefault`).
 *
 * Owner-scoped:
 *   - error-feed incidents: kept iff `resolveErrorEventOwner(...) === owner`.
 *   - DB Health panel (top tables / slow queries / proposals): only surfaced under
 *     `platform` (DB is Devi's — Nano's Platform lane).
 *   - supabase-logs entries are a source inside the error-feed already, so they're
 *     covered by the same incident filter above.
 *
 * See also [[../../../docs/brain/libraries/control-tower-infra-tab]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveNodeOwner } from "./node-registry";
import { getControlTowerDbPanels, type ControlTowerDbPanels } from "./snapshot";
import type { ErrorSource, ErrorIncident } from "./error-feed";
import type { OwnerFunction } from "./registry";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * One row of the flattened per-department error feed — a normal [[./error-feed]] incident
 * plus its resolved owner (echoed so the client can render "platform (default)" for
 * fall-through rows without redoing the lookup).
 */
export interface InfraTabErrorIncident extends ErrorIncident {
  /** The `OwnerFunction` this row's surface resolves to via [[./node-registry]]
   *  `resolveNodeOwner`, or `null` when nothing in the sample maps to a registered node
   *  (in which case the payload assigns it to `platform` by default). */
  resolvedOwner: OwnerFunction | null;
}

export interface InfraTabPayload {
  generatedAt: string;
  /** The department whose ancestry filtered every row below. */
  owner: OwnerFunction;
  /** Every error-feed row (last 7d) whose surface resolves under this department. */
  errorFeed: {
    incidents: InfraTabErrorIncident[];
    /** Count of surviving incidents per source (for the header chips). */
    bySource: Record<ErrorSource, number>;
    /** Sum of `count` across surviving incidents. */
    totalOccurrences: number;
  };
  /** DB Health panel — surfaced ONLY under `platform` (Devi's Nano lane). null for
   *  every other department; the client hides the panel when null. */
  dbHealth: ControlTowerDbPanels["dbHealth"] | null;
}

/** Look-back matches [[./error-feed]] `FEED_LOOKBACK_MS` — the last week of activity. */
const FEED_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * URL-prefix → OwnerFunction map for a `sample.path` on a `vercel` (or a `supabase`
 * row whose caller added `context.path`). Kept coarse — the goal is a defensible
 * default lane for a path we can't otherwise route via a registered node id. The
 * fall-through is `platform` (via the caller); we return `null` here so
 * `resolveErrorEventOwner` can distinguish "genuinely un-routed" from "routed here".
 */
function routeOwnerFromPath(path: string): OwnerFunction | null {
  const p = path.toLowerCase();
  if (p.startsWith("/api/portal")) return "retention";
  if (p.startsWith("/api/orchestrator")) return "cs";
  if (p.startsWith("/api/tickets") || p.startsWith("/api/ticket-")) return "cs";
  if (p.startsWith("/api/webhooks/shopify")) return "retention";
  if (p.startsWith("/api/webhooks/appstle")) return "retention";
  if (p.startsWith("/api/webhooks/braintree")) return "retention";
  if (p.startsWith("/api/webhooks/stripe")) return "retention";
  if (p.startsWith("/api/webhooks/meta")) return "growth";
  if (p.startsWith("/api/webhooks/klaviyo")) return "growth";
  if (p.startsWith("/api/developer")) return "platform";
  if (p.startsWith("/api/webhooks/vercel-logs")) return "platform";
  if (p.startsWith("/api/client-errors")) return "platform";
  return null;
}

/**
 * Resolve the OwnerFunction that owns a single `error_events` row — the spine of the
 * per-department Infra tab. Returns `null` when nothing in the row's `sample` maps to
 * a registered node id or a known route prefix; the caller decides how to route that
 * fall-through (this module routes it to `platform`).
 *
 * Candidates checked, in order:
 *   1. `sample.function_id` — set on inngest failures (matches a `MONITORED_LOOPS.id`).
 *   2. `sample.surface` on `source='client'` — `portal` / `storefront` are the two
 *      customer-facing surfaces, both retention-owned (Sol / Cora / the portal SDK).
 *   3. `sample.path` (vercel + some supabase) — routed via `routeOwnerFromPath`.
 *
 * A `supabase-logs` row has neither a `function_id` nor a `path` — Postgres/auth
 * logs are DB-level and always fall through to `platform`.
 */
export function resolveErrorEventOwner(
  source: ErrorSource,
  sample: unknown,
): OwnerFunction | null {
  if (!sample || typeof sample !== "object") return null;
  const s = sample as Record<string, unknown>;

  // 1. Any function_id in the sample maps to a MONITORED_LOOPS node → its owner.
  const fnId = typeof s.function_id === "string" ? s.function_id : null;
  if (fnId) {
    const owner = resolveNodeOwner(fnId);
    if (owner) return owner;
  }

  // 2. Client errors carry `surface` (portal / storefront) — the customer-facing
  //    lanes. Both are retention-owned (portal is Appstle-replacement; storefront
  //    checkout/PDP is customer-retention surface).
  if (source === "client") {
    const surface = typeof s.surface === "string" ? s.surface : null;
    if (surface === "portal" || surface === "storefront") return "retention";
  }

  // 3. A path on the row (vercel or a supabase context that named one) — route via
  //    the URL-prefix map.
  const path = typeof s.path === "string" ? s.path : null;
  if (path) {
    return routeOwnerFromPath(path);
  }

  return null;
}

/** Every `ErrorSource` for the `bySource` counts init — mirrors [[./error-feed]] `SOURCES`. */
const ALL_SOURCES: ErrorSource[] = ["vercel", "inngest", "supabase", "supabase-logs", "client"];

/**
 * Build the pre-shaped payload the /api/developer/control-tower/infra route returns
 * for one department. The client never has to touch a raw feed — every incident is
 * pre-filtered + pre-tagged with its resolved owner, and the DB Health panel is
 * omitted for every non-platform department (Devi's Nano lane is Platform-only).
 *
 * Fall-through rule: a row whose surface doesn't resolve to any known node falls to
 * `platform`. So the `platform` Infra tab always includes the un-routed backlog —
 * matching the ORPHAN_OWNER default in [[./node-registry]]
 * `resolveNodeOwnerOrOrphanDefault`. Every other department only sees rows whose
 * surface EXPLICITLY resolves to it.
 */
export async function buildInfraTabPayload(
  admin: Admin,
  owner: OwnerFunction,
  workspaceId: string,
): Promise<InfraTabPayload> {
  const since = new Date(Date.now() - FEED_LOOKBACK_MS).toISOString();
  const [errRes, dbPanels] = await Promise.all([
    admin
      .from("error_events")
      .select("id, source, signature, title, detail, sample, count, first_seen_at, last_seen_at")
      .gte("last_seen_at", since)
      .order("last_seen_at", { ascending: false })
      .limit(500),
    owner === "platform"
      ? getControlTowerDbPanels(admin, workspaceId)
      : Promise.resolve(null),
  ]);

  const rows = (errRes.data ?? []) as Array<ErrorIncident & { sample: unknown; source: ErrorSource }>;

  const incidents: InfraTabErrorIncident[] = [];
  const bySource: Record<ErrorSource, number> = {
    vercel: 0,
    inngest: 0,
    supabase: 0,
    "supabase-logs": 0,
    client: 0,
  };
  let totalOccurrences = 0;

  for (const row of rows) {
    const resolvedOwner = resolveErrorEventOwner(row.source, row.sample);
    // Fall-through: an unresolved row falls to `platform` — the ancestry-off-tree default.
    const rowOwner: OwnerFunction = resolvedOwner ?? "platform";
    if (rowOwner !== owner) continue;
    incidents.push({
      id: row.id,
      source: row.source,
      signature: row.signature,
      title: row.title,
      detail: row.detail,
      count: row.count,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      resolvedOwner,
    });
    bySource[row.source] += 1;
    totalOccurrences += row.count ?? 0;
  }

  // Sanity: initialise counts to 0 for every source (mirrors the ErrorFeedPanel shape).
  for (const src of ALL_SOURCES) {
    if (!(src in bySource)) bySource[src] = 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    owner,
    errorFeed: {
      incidents,
      bySource,
      totalOccurrences,
    },
    dbHealth: dbPanels ? dbPanels.dbHealth : null,
  };
}
