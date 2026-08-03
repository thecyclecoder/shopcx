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
import { escalateReconnectRequired } from "@/lib/meta/reconnect-required-escalation";
import {
  isAppOwnerActionRequiredError as isAppOwnerActionRequiredErrorImpl,
  type GraphError,
} from "@/lib/meta/graph-retry";

/**
 * True iff `err` was tagged by [[../meta/graph-retry]] `graphError` as the
 * app-owner-action-required class (canonical: Data Use Checkup 400). The
 * `metaIterationRun` catch block uses this to gate the human-blocked branch;
 * every other error still rethrows via `notifyOpsAlert` + throw.
 *
 * Re-exports the canonical predicate that now lives in
 * [[../meta/graph-retry]] so a NEW human-blocked class is added once (there)
 * instead of touching this file plus four others. The existing
 * `meta-performance.test.ts` import path stays stable.
 */
export const isAppOwnerActionRequiredError = isAppOwnerActionRequiredErrorImpl;

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

type EscalateReconnectFn = typeof escalateReconnectRequired;

/**
 * Sibling of [[escalateAppOwnerActionForIterationRun]] for the
 * `reconnect_required` class — same explicit workspace-argument shape (no
 * module-global, no AsyncLocalStorage), same label convention. Book the
 * deduped CEO card for a `metaIterationRun` invocation whose Graph call
 * raised a `reconnect_required` GraphError; the escalation SDK itself
 * confirms token death via `debug_token` before touching
 * dashboard_notifications, so a single-sighting string trigger cannot
 * misroute the founder from here either.
 *
 * Introduced by [[../../../docs/brain/specs/meta-reconnect-required-class]]
 * Phase 3.
 */
export async function escalateReconnectRequiredForIterationRun(
  admin: Admin,
  err: unknown,
  scope: IterationRunAppOwnerActionScope,
  escalate: EscalateReconnectFn = escalateReconnectRequired,
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
