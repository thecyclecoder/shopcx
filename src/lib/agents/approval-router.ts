/**
 * Approval router (approval-routing-engine spec, Phase 1) — route an approval UP the org chart
 * to the first live+autonomous supervisor, else the CEO.
 *
 * North star (operational-rules § supervisable autonomy): an autonomous tool answers to an
 * objective-owner, never a silent proxy. When a tool needs sign-off, the request routes to the
 * first ancestor FUNCTION that is BOTH `live` (its director-agent is running) AND `autonomous`
 * (trusted to auto-decide); if no ancestor qualifies, it falls through to the CEO — the fail-safe
 * root. The owner function itself is the first candidate (a live+autonomous owner approves its
 * own tools' requests).
 *
 * Safety invariants baked in here:
 *   - Route UP, never sideways or down — only ancestors (and the CEO) are ever considered.
 *   - Default to CEO — any function not live && autonomous (the all-off default today) falls
 *     through to the CEO. A missing flag row ⇒ off, so an unconfigured org never auto-approves.
 *   - Acyclic-safe — a `visited` guard defends a malformed chart (returns CEO, never loops).
 *
 * The graph is the functions/*.md org chart, which today is FLAT: every director reports to the
 * CEO (there is no director-of-directors). The walk is written generically (a parentOf map +
 * visited guard) so a future deeper chart Just Works with no change here.
 *
 * `resolveApprover` is PURE — the chart + live flags are passed in — so it is unit-tested against
 * fixture trees (approval-router.test.ts). The async helpers below read the live chart + flags.
 */
import { listFunctionSlugs } from "@/lib/brain-roadmap";
import { createAdminClient } from "@/lib/supabase/admin";

/** The root seat every approval ultimately falls through to. Not a function row — implicit root. */
export const CEO = "ceo";

/** One row of public.function_autonomy. */
export interface FunctionAutonomyRow {
  function_slug: string;
  live: boolean;
  autonomous: boolean;
  updated_by?: string | null;
  updated_at?: string;
}

/** Per-function live+autonomous flags, keyed by slug. A missing slug ⇒ off (fail-safe default). */
export type AutonomyMap = Record<string, { live: boolean; autonomous: boolean }>;

/**
 * The org chart as a parent map: function slug → its parent slug. A function reporting to the CEO
 * maps to `CEO` (or is simply absent — both mean "parent is the CEO"). Acyclic (the chart is a tree).
 */
export interface OrgChartGraph {
  parentOf: Record<string, string>;
}

/** Is this function an auto-approver right now? BOTH flags must be on (fail-safe: default off). */
export function isAutoApprover(slug: string, autonomy: AutonomyMap): boolean {
  const a = autonomy[slug];
  return !!a && a.live === true && a.autonomous === true;
}

/**
 * PURE. Walk UP from `ownerFunction` (the raising tool's owner) — the owner itself included — to
 * the first ancestor that is live && autonomous; that function is the approver. If none qualifies
 * up to the root, return the CEO. Only ancestors are considered (never a peer or child). Cycle-safe.
 */
export function resolveApprover(
  ownerFunction: string | null | undefined,
  chart: OrgChartGraph,
  autonomy: AutonomyMap,
): string {
  if (!ownerFunction || ownerFunction === CEO) return CEO;
  const visited = new Set<string>();
  let cur: string | undefined = ownerFunction;
  while (cur && cur !== CEO && !visited.has(cur)) {
    visited.add(cur);
    if (isAutoApprover(cur, autonomy)) return cur;
    cur = chart.parentOf[cur]; // up to the parent (undefined ⇒ top-level ⇒ falls through to CEO)
  }
  return CEO;
}

/**
 * Build the org-chart parent map from the brain. The functions/*.md org chart is FLAT today —
 * every director reports to the CEO — so every known slug maps to `CEO`. Reads the slug list from
 * the brain so a new functions/*.md director is picked up with no code change (no second copy of
 * the org chart). When the chart deepens, this is the one place that learns the deeper parentage.
 */
export async function buildOrgChartGraph(): Promise<OrgChartGraph> {
  const slugs = await listFunctionSlugs();
  const parentOf: Record<string, string> = {};
  for (const s of slugs) parentOf[s] = CEO;
  return { parentOf };
}

/** Load the live per-function flags from public.function_autonomy. Missing/error ⇒ {} (all off). */
export async function loadAutonomyMap(): Promise<AutonomyMap> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("function_autonomy").select("function_slug, live, autonomous");
  if (error || !data) return {};
  const map: AutonomyMap = {};
  for (const row of data as FunctionAutonomyRow[]) {
    map[row.function_slug] = { live: !!row.live, autonomous: !!row.autonomous };
  }
  return map;
}

/** Convenience: resolve the approver for a tool owned by `ownerFunction`, reading the live state. */
export async function resolveApproverLive(ownerFunction: string | null | undefined): Promise<string> {
  const [chart, autonomy] = await Promise.all([buildOrgChartGraph(), loadAutonomyMap()]);
  return resolveApprover(ownerFunction, chart, autonomy);
}
