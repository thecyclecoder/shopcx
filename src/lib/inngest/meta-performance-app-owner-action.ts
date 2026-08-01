/**
 * Invocation-local app-owner-action-required handling for
 * [[./meta-performance]] `metaIterationRun` — the Meta App Dashboard gate
 * (canonical: yearly Data Use Checkup, which pins every affected account's
 * Graph call to a permanent-until-cleared 400 that no Inngest retry can
 * clear).
 *
 * The catch block in `metaIterationRun` calls
 * [[escalateAppOwnerActionForIterationRun]] with THIS invocation's
 * `event.data.workspace_id`, then records `finishRun` as human-blocked and
 * returns without `notifyOpsAlert` / rethrow — a genuine outage or code defect
 * still falls through to the loud rethrow branch. NEVER wires a
 * module-global handler or an AsyncLocalStorage workspace scope: two
 * overlapping `meta/iteration-run` publishes for different workspaces cannot
 * cross-contaminate each other's service-role notification writes because
 * this SDK receives the workspace id as an explicit argument bound at the
 * call site.
 *
 * Lives in its own module (not in [[./meta-performance]]) so the workspace-
 * isolation regression test can pin both the tagged and control branches
 * without dragging the Inngest sink through its transitive control-tower ↔
 * registered-functions cycle (a TDZ on `metaSyncPerformance`).
 *
 * Sibling of [[./meta-sync]] `handleMetaSyncSpendError` — same shape, same
 * invariant, different endpoint label.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { escalateAppOwnerActionRequired } from "@/lib/meta/app-owner-action-escalation";
import type { GraphError } from "@/lib/meta/graph-retry";

/**
 * True iff `err` was tagged by [[../meta/graph-retry]] `graphError` as the
 * app-owner-action-required class (canonical: Data Use Checkup 400). The
 * `metaIterationRun` catch block uses this to gate the human-blocked branch;
 * every other error still rethrows via `notifyOpsAlert` + throw.
 */
export function isAppOwnerActionRequiredError(err: unknown): boolean {
  return (err as { metaClass?: string } | null)?.metaClass === "app_owner_action_required";
}

type Admin = ReturnType<typeof createAdminClient>;
type EscalateFn = typeof escalateAppOwnerActionRequired;

export interface IterationRunAppOwnerActionScope {
  workspaceId: string;
  adAccountId: string;
}

/**
 * Book the deduped CEO card for a `metaIterationRun` invocation whose Graph
 * call raised an `app_owner_action_required` GraphError. The `workspaceId`
 * arrives as an explicit argument sourced from `event.data.workspace_id` at
 * the call site — never from a module-global scope, never from
 * AsyncLocalStorage — so two overlapping calls for different workspaces
 * cannot leak into each other's dashboard_notifications insert.
 *
 * `escalate` defaults to the production
 * [[../meta/app-owner-action-escalation]] `escalateAppOwnerActionRequired`;
 * tests pin a fake to assert per-call workspace propagation.
 */
export async function escalateAppOwnerActionForIterationRun(
  admin: Admin,
  err: unknown,
  scope: IterationRunAppOwnerActionScope,
  escalate: EscalateFn = escalateAppOwnerActionRequired,
): Promise<void> {
  const graphErr = err as GraphError;
  await escalate(admin, {
    workspaceId: scope.workspaceId,
    label: `meta/iteration-run account ${scope.adAccountId}`,
    status: graphErr.httpStatus ?? 400,
    error: graphErr,
    affectedAdAccountIds: [scope.adAccountId],
  });
}
