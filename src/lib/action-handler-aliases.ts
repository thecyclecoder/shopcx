/**
 * Handler-alias catalog for the orchestrator's action executor.
 *
 * Reads the DB-driven `public.action_handler_aliases` table and maps an
 * emitted action_type (e.g. `cancel_subscription`) to the canonical
 * handler key registered in `directActionHandlers` (e.g. `cancel`), so
 * near-miss emissions from Sonnet hit real handlers instead of the
 * executor's silent "Unknown action type" branch.
 *
 * See docs/brain/specs/orchestrator-handler-alias-catalog-for-no-handler-misses.md
 * (Phase 1) and docs/brain/tables/action_handler_aliases.md.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface AliasRow {
  workspace_id: string | null;
  source_type: string;
  target_type: string;
  active: boolean;
}

/**
 * Pure resolver — pick the best alias target for a (workspaceId, sourceType)
 * pair from an in-memory list of alias rows. Extracted so the resolver logic
 * can be unit-tested without spinning up a DB.
 *
 * Rules:
 *   1. Only rows with `active=true` count.
 *   2. A workspace-scoped row (workspace_id === workspaceId) wins over a
 *      global row (workspace_id === null) with the same source_type — that
 *      is how a workspace overrides a global mapping (or disables one by
 *      inserting an inactive workspace row).
 *   3. If neither a workspace nor a global row matches, returns null and the
 *      caller falls through to its "Unknown action type" branch.
 */
export function pickAliasTarget(
  aliases: AliasRow[],
  workspaceId: string,
  sourceType: string,
): string | null {
  // Any workspace-scoped row for this source_type — active or inactive —
  // means "this workspace has an opinion" and suppresses the global
  // fallback. That is what makes an inactive scoped row a valid way to
  // disable an inherited global mapping without deleting the shared row.
  let scoped: AliasRow | undefined;
  let global: AliasRow | undefined;
  for (const a of aliases) {
    if (a.source_type !== sourceType) continue;
    if (a.workspace_id === workspaceId) scoped = a;
    else if (a.workspace_id === null) global = a;
  }
  if (scoped) return scoped.active ? scoped.target_type : null;
  if (global && global.active) return global.target_type;
  return null;
}

/**
 * DB-backed resolver used by the executor. Reads the two candidate rows
 * (workspace-scoped + global) with a single query, then delegates to
 * `pickAliasTarget` for the win rule.
 *
 * Returns the canonical handler key on a hit, or null on a miss. Errors
 * from the DB layer are swallowed (returned as null): a resolver miss
 * lands the caller on its existing "Unknown action type" branch, which is
 * the pre-catalog behavior — so a transient Postgres blip cannot make the
 * executor worse than it was before this catalog existed.
 */
export async function resolveAlias(
  admin: Admin,
  workspaceId: string,
  sourceType: string,
): Promise<string | null> {
  // Do NOT filter on `active` here — the picker needs to see an inactive
  // workspace-scoped row so it can honor the "workspace has opted out of
  // an inherited global" case (see pickAliasTarget).
  const { data, error } = await admin
    .from("action_handler_aliases")
    .select("workspace_id, source_type, target_type, active")
    .eq("source_type", sourceType)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
  if (error || !data) return null;
  return pickAliasTarget(data as AliasRow[], workspaceId, sourceType);
}
