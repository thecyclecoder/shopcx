/**
 * app-owner-action-escalation — the CEO-facing surface for a Meta capability
 * that requires the workspace OWNER to clear a gate in the Meta App Dashboard.
 * When [[./graph-retry]] classifies a response as
 * [[./graph-retry]] `classifyAppOwnerActionRequired` (canonical example: the
 * yearly "Data Use Checkup" that disables an app's API access until the
 * workspace owner completes it), this SDK raises a deduped
 * `dashboard_notifications` card that names the CALLING FUNCTION and links to
 * the Meta App Dashboard so the owner can act.
 *
 * The point is turning "the 5-min today-sync cron logs an identical HTTP 400
 * error every tick per active ad account (~576/day per workspace) with no
 * additional information beyond the first occurrence" into "one deduped CEO
 * card per workspace per UTC day naming the action required and where to take
 * it" — retrying will never fix this class, only a human can.
 *
 * Wiring: this module registers itself against [[./graph-retry]] via
 * `registerAppOwnerActionRequiredHandler` when [[installDefaultAppOwnerActionEscalationHandler]]
 * is called at a request/pass boundary that knows the workspace scope. The
 * handler is fire-and-forget (graph-retry stays pure, DB-free, and
 * unit-testable); a DB write failure is swallowed and logged so a broken
 * escalation never masks the underlying throw.
 *
 * Dedupe: at most one card per (workspace, UTC day) — a persistent Data Use
 * Checkup gate therefore surfaces at most once per day per workspace, not
 * once per retry, not once per active ad account.
 *
 * Introduced by [[../../../docs/brain/specs/meta-graph-classify-app-owner-action-required-data-use-check]]
 * Phase 1.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { createAdminClient } from "@/lib/supabase/admin";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import {
  type GraphError,
  registerAppOwnerActionRequiredHandler,
  type AppOwnerActionRequiredContext,
} from "@/lib/meta/graph-retry";

type Admin = ReturnType<typeof createAdminClient>;

/** Deep link the escalation surfaces on the CEO's inbox card — the Meta App Dashboard. */
const META_APP_DASHBOARD_LINK = "https://developers.facebook.com/apps/";

/** Owner function — Platform owns infra reliability; Meta capability gate blocks it. */
const PLATFORM_DIRECTOR_FUNCTION = "platform";

export interface EscalateAppOwnerActionRequiredInput {
  workspaceId: string;
  /**
   * The endpoint label passed to `graphFetchJson` — typically
   * `"GET act_.../insights"`. Used verbatim in the card body so the CEO can
   * see WHICH request tripped the gate.
   */
  label: string;
  /** HTTP status Meta returned (always 400 for this class). */
  status: number;
  /** The tagged `GraphError` — carries the canonical Meta message + code. */
  error: GraphError;
  /**
   * Optional list of Meta ad account IDs affected — surfaces in the card body
   * so the CEO knows exactly which accounts are blocked. Omit when the caller
   * doesn't know (fine — the card still names the workspace).
   */
  affectedAdAccountIds?: string[];
  /** Override "now" — tests pin this so the dedupe day is deterministic. */
  nowMs?: number;
}

export interface EscalateAppOwnerActionRequiredResult {
  emitted: boolean;
}

/**
 * Raise the CEO card. Idempotent per (workspace, UTC day) — the confirming
 * predicate is `metadata->>dedupe_key`, and we insert only after the SELECT
 * returns zero rows. Returns `{emitted:false}` on a same-day duplicate or a
 * DB write failure (write failures are logged, never rethrown).
 */
export async function escalateAppOwnerActionRequired(
  admin: Admin,
  input: EscalateAppOwnerActionRequiredInput,
): Promise<EscalateAppOwnerActionRequiredResult> {
  const day = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10);
  const dedupeKey = `app_owner_action_required:${input.workspaceId}:${day}`;

  try {
    const { data: prior } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .eq("metadata->>dedupe_key", dedupeKey)
      .limit(1);
    if ((prior ?? []).length > 0) return { emitted: false };
  } catch (err) {
    console.warn(
      "[app-owner-action-escalation] prior-card lookup failed (skipping card)",
      { err },
    );
    return { emitted: false };
  }

  const accountsLine =
    (input.affectedAdAccountIds ?? []).length > 0
      ? `Affected ad accounts: ${(input.affectedAdAccountIds ?? []).join(", ")}\n`
      : "";
  const title = "Meta App Dashboard action required — Data Use Checkup / API access disrupted";
  const body = (
    `Meta returned a permanent-until-cleared error for ${input.label} — your Meta app requires the workspace OWNER ` +
    `to complete an action in the Meta App Dashboard before the API will return data again.\n` +
    `Message: ${(input.error.message || "").slice(0, 500)}\n` +
    accountsLine +
    `\nOpen the Meta App Dashboard, find your app, and complete the flagged item ` +
    `(commonly the yearly Data Use Checkup). Retrying will not fix this — only a human clearing the gate can. ` +
    `This card dedupes to one per workspace per UTC day, so today's remaining occurrences will collapse here.`
  ).slice(0, 4000);

  try {
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: input.workspaceId,
      type: APPROVAL_REQUEST_TYPE,
      title,
      body,
      link: META_APP_DASHBOARD_LINK,
      metadata: {
        routed_to_function: "ceo",
        escalated_by_director: PLATFORM_DIRECTOR_FUNCTION,
        escalation_kind: "app_owner_action_required",
        calling_function: input.label,
        http_status: input.status,
        meta_message: (input.error.message || "").slice(0, 2000),
        affected_ad_account_ids: input.affectedAdAccountIds ?? [],
        dedupe_key: dedupeKey,
        approve_action_id: null,
      },
      read: false,
      dismissed: false,
    });
    if (error) {
      console.warn("[app-owner-action-escalation] insert failed", { error, dedupeKey });
      return { emitted: false };
    }
    return { emitted: true };
  } catch (err) {
    console.warn("[app-owner-action-escalation] insert threw", { err, dedupeKey });
    return { emitted: false };
  }
}

/**
 * Default-handler workspace scope. `graphFetchJson` doesn't know the calling
 * workspace, so callers wrap the awaited Graph work in
 * [[runWithAppOwnerActionWorkspaceScope]] which pushes the workspace id onto
 * an AsyncLocalStorage store. When the tagged error fires, the handler
 * consults `getStore()` from within the SAME async chain that made the call,
 * so two overlapping publishes for different workspaces each see their own
 * scope — no cross-workspace card leak. If no scope is set the handler is a
 * no-op (the CLASS is still preserved on the thrown `GraphError.metaClass`
 * so a caller that catches the throw can escalate through this SDK
 * explicitly).
 *
 * Why AsyncLocalStorage over a module-level mutable variable: the previous
 * `setCurrentAppOwnerActionWorkspaceScope(workspaceId)` + `finally` cleanup
 * pattern was a process-global. Two concurrent Inngest publishes for
 * different workspaces interleave their awaits — publish A sets scope=A,
 * publish B sets scope=B, publish A's Graph call fires, handler reads B —
 * the card is booked against the wrong workspace. AsyncLocalStorage binds
 * the scope to the async chain, not the module, closing that race.
 */
const workspaceScopeStore = new AsyncLocalStorage<{ workspaceId: string }>();

/**
 * Bind the app-owner-action workspace scope to `workspaceId` for the
 * duration of `fn` (and every await reached from it, transitively). Nested
 * calls shadow the outer scope; overlapping chains see only their own.
 * MUST wrap every await that could raise a Meta `app_owner_action_required`
 * error — a plain mutation before the awaits (as the retired
 * `setCurrentAppOwnerActionWorkspaceScope` module-global did) races on
 * concurrent publishes and books cards against the wrong workspace.
 */
export function runWithAppOwnerActionWorkspaceScope<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return workspaceScopeStore.run({ workspaceId }, fn);
}

export function getCurrentAppOwnerActionWorkspaceScope(): string | null {
  return workspaceScopeStore.getStore()?.workspaceId ?? null;
}

/**
 * Install the default handler that raises the CEO card when an
 * app-owner-action-required error fires AND a workspace scope is set. Import
 * from an app-startup path (typically the today-sync inngest function) and
 * run the awaited Graph work inside [[runWithAppOwnerActionWorkspaceScope]]
 * so the handler can resolve the caller's workspace.
 */
export function installDefaultAppOwnerActionEscalationHandler(admin: Admin): void {
  registerAppOwnerActionRequiredHandler((ctx: AppOwnerActionRequiredContext) => {
    const workspaceId = getCurrentAppOwnerActionWorkspaceScope();
    if (!workspaceId) return;
    void escalateAppOwnerActionRequired(admin, {
      workspaceId,
      label: ctx.label,
      status: ctx.status,
      error: ctx.error,
    });
  });
}
