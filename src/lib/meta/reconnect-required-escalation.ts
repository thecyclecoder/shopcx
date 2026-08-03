/**
 * reconnect-required-escalation — the CEO-facing surface for a Meta
 * `reconnect_required` classification: the app-level gate is CLEAR but the
 * stored per-workspace user access token has been invalidated by Meta and
 * only re-authorizing OAuth restores access. Distinct from the sibling
 * [[./app-owner-action-escalation]], which routes the workspace owner to the
 * Meta App Dashboard — that card would send the founder down the wrong
 * remedy path for THIS class of failure.
 *
 * The 2026-08-02 Meta incident is the seed: after the CEO completed the Data
 * Use Checkup, Meta switched to HTTP 400 `"API access blocked."` on every
 * call made with the stored user token, while the APP token
 * (`{app_id}|{secret}`) still returned 200 and webhook subscriptions stayed
 * active. That user-token-dead / app-token-live asymmetry is the whole
 * diagnostic; nothing was left to do in the App Dashboard.
 *
 * ⚠ CONFIRM BEFORE ESCALATING. [[./graph-retry]] `classifyReconnectRequired`
 * classifies purely on a string trigger, and the seed phrasing
 * `"api access blocked"` was observed EXACTLY ONCE across a ~40-minute
 * window on 2026-08-02. This SDK stops a single-sighting string from
 * misrouting the founder by probing Meta's `debug_token` endpoint for the
 * workspace's stored user token BEFORE any card is raised, and emitting a
 * card only when Meta reports the token as invalid. If the probe itself
 * errors, or reports the token VALID, this SDK returns `{ emitted:false }`
 * — a broken probe must NEVER produce a false-positive card. Do NOT
 * 'simplify' the confirmation away in a future refactor.
 *
 * Dedupe: at most one card per (workspace, UTC day) on
 * `metadata->>dedupe_key` = `reconnect_required:{workspaceId}:{day}`. A
 * persistent invalid-token state therefore surfaces at most once per day per
 * workspace, not once per retry, not once per active ad account.
 *
 * Workspace-scope isolation: the prior-card `SELECT` filters on
 * `workspace_id` — mandatory per two already-folded specs
 * ([[../../../docs/brain/specs/meta-sync-spend-escalation-workspace-scope-isolation]],
 * [[../../../docs/brain/specs/fix-ad-tool-app-owner-action-scope-isolation]])
 * that exist because this exact class of prior-card query leaked across
 * workspaces. Regression guard lives in
 * [[./reconnect-required-escalation.workspace-scope.test.ts]].
 *
 * Wiring: [[installDefaultReconnectRequiredEscalationHandler]] registers a
 * fire-and-forget handler against [[./graph-retry]] via
 * `registerReconnectRequiredHandler`. Call sites wrap awaited Graph work in
 * [[runWithReconnectRequiredWorkspaceScope]] so the handler resolves the
 * caller's workspace via AsyncLocalStorage — the same non-racy pattern the
 * app-owner sibling uses, so two overlapping publishes for different
 * workspaces each see their own scope.
 *
 * Introduced by [[../../../docs/brain/specs/meta-reconnect-required-class]]
 * Phase 2.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import {
  type GraphError,
  registerReconnectRequiredHandler,
  type ReconnectRequiredContext,
} from "@/lib/meta/graph-retry";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Deep link the escalation surfaces on the CEO's inbox card — the
 * in-product integrations page where the OAuth reconnect flow lives.
 * Deliberately NOT the Meta App Dashboard: an App Dashboard link for this
 * class of failure sends the founder down the wrong remedy path.
 */
const META_INTEGRATIONS_RECONNECT_LINK = "/dashboard/settings/integrations/meta";

/** Owner function — Platform owns infra reliability; Meta credential state blocks it. */
const PLATFORM_DIRECTOR_FUNCTION = "platform";

/** Meta Graph base — pinned to v21.0, matching [[../meta-ads]]. */
const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/**
 * The verdict returned by the `debug_token` probe. `reachable=false` means we
 * could not reach Meta OR the probe threw — never a card in that state, the
 * probe itself is unreliable. `reachable=true, valid=true` means Meta says
 * the token is fine — never a card either, the string trigger was a false
 * positive. `reachable=true, valid=false` is the ONLY card-raising verdict.
 */
export type DebugTokenVerdict =
  | { reachable: false; reason: string }
  | { reachable: true; valid: boolean };

/**
 * Probe implementation — dependency-injected via
 * [[EscalateReconnectRequiredInput]] `probeDebugToken` so the workspace-scope
 * regression test can stub it without hitting the network. Real callers omit
 * it and get [[defaultProbeDebugToken]].
 */
export type DebugTokenProbe = (args: {
  admin: Admin;
  workspaceId: string;
}) => Promise<DebugTokenVerdict>;

export interface EscalateReconnectRequiredInput {
  workspaceId: string;
  /**
   * The endpoint label passed to `graphFetchJson` — typically
   * `"GET act_.../insights"`. Used verbatim in the card body so the CEO can
   * see WHICH request tripped the classifier.
   */
  label: string;
  /** HTTP status Meta returned (always 400 for this class). */
  status: number;
  /** The tagged `GraphError` — carries the canonical Meta message. */
  error: GraphError;
  /**
   * Optional list of Meta ad account IDs affected — surfaces in the card so
   * the CEO knows exactly which accounts have gone unmeasured while
   * disconnected. Omit when the caller doesn't know.
   */
  affectedAdAccountIds?: string[];
  /** Override "now" — tests pin this so the dedupe day is deterministic. */
  nowMs?: number;
  /**
   * Dependency-inject the debug_token probe. Default:
   * [[defaultProbeDebugToken]] which calls Meta. Tests stub this so the
   * regression guard does not hit the network.
   */
  probeDebugToken?: DebugTokenProbe;
}

export interface EscalateReconnectRequiredResult {
  emitted: boolean;
}

/**
 * Read the workspace's stored user access token — matches the spec's
 * `workspaces.meta_user_access_token_encrypted` column. `meta_connections`
 * is deliberately NOT read here: the spec pins the workspaces column as
 * canonical, and the connections table is a separate concern that Phase 1's
 * incident specifically involved the workspaces-level token going stale.
 */
async function readWorkspaceMetaUserToken(
  admin: Admin,
  workspaceId: string,
): Promise<string | null> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("meta_user_access_token_encrypted")
    .eq("id", workspaceId)
    .maybeSingle();
  const enc = (ws as { meta_user_access_token_encrypted?: string | null } | null)
    ?.meta_user_access_token_encrypted;
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch (err) {
    console.warn("[reconnect-required-escalation] token decrypt failed", { err, workspaceId });
    return null;
  }
}

/**
 * Default probe — calls Meta's `GET /debug_token?input_token={t}&access_token={app_id}|{app_secret}`
 * using the APP token (which keeps working in the reconnect_required state —
 * that asymmetry is the diagnostic). Returns `reachable=false` on any
 * network / decode / config failure so the caller fails closed (no card on
 * an unreliable probe).
 */
export const defaultProbeDebugToken: DebugTokenProbe = async ({ admin, workspaceId }) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return { reachable: false, reason: "META_APP_ID/SECRET not configured" };
  }
  const userToken = await readWorkspaceMetaUserToken(admin, workspaceId);
  if (!userToken) {
    // No stored token means nothing to invalidate — a card would confuse the
    // founder ("reconnect what?"). Treat as reachable+valid so the caller
    // does not raise a card; a truly disconnected workspace has a different
    // surface for surfacing that state.
    return { reachable: true, valid: true };
  }
  const url =
    `${GRAPH_BASE}/debug_token` +
    `?input_token=${encodeURIComponent(userToken)}` +
    `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return { reachable: false, reason: `fetch threw: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return { reachable: false, reason: `debug_token http_${res.status}` };
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    return { reachable: false, reason: `debug_token json_decode: ${(err as Error).message}` };
  }
  const data = (payload as { data?: { is_valid?: unknown } })?.data;
  if (data == null || typeof data.is_valid !== "boolean") {
    return { reachable: false, reason: "debug_token payload missing data.is_valid" };
  }
  return { reachable: true, valid: data.is_valid };
};

/**
 * Raise the CEO card — idempotent per (workspace, UTC day). Confirms the
 * token IS invalid via debug_token before touching `dashboard_notifications`.
 *
 * Returns `{emitted:false}` when:
 *   • the debug_token probe was unreachable (fail-closed on unreliable probe),
 *   • the probe reported the token VALID (string trigger was a false positive),
 *   • the prior-card lookup found today's row (dedupe),
 *   • or the insert failed (logged, never rethrown).
 */
export async function escalateReconnectRequired(
  admin: Admin,
  input: EscalateReconnectRequiredInput,
): Promise<EscalateReconnectRequiredResult> {
  // Confirmation gate. A single-sighting string MUST NOT be enough to raise a
  // founder-facing card — Meta's debug_token endpoint is the ground truth.
  const probe = input.probeDebugToken ?? defaultProbeDebugToken;
  let verdict: DebugTokenVerdict;
  try {
    verdict = await probe({ admin, workspaceId: input.workspaceId });
  } catch (err) {
    console.warn("[reconnect-required-escalation] probe threw (fail-closed)", {
      err,
      workspaceId: input.workspaceId,
    });
    return { emitted: false };
  }
  if (!verdict.reachable) {
    console.warn(
      "[reconnect-required-escalation] debug_token unreachable — not raising card",
      { workspaceId: input.workspaceId, reason: verdict.reason },
    );
    return { emitted: false };
  }
  if (verdict.valid) {
    console.warn(
      "[reconnect-required-escalation] debug_token reports token VALID — string trigger was a false positive; not raising card",
      { workspaceId: input.workspaceId },
    );
    return { emitted: false };
  }

  const day = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10);
  const dedupeKey = `reconnect_required:${input.workspaceId}:${day}`;

  try {
    const { data: prior } = await admin
      .from("dashboard_notifications")
      .select("id")
      // MANDATORY workspace scope — two already-folded specs
      // (meta-sync-spend-escalation-workspace-scope-isolation,
      // fix-ad-tool-app-owner-action-scope-isolation) exist because this exact
      // prior-card query leaked across workspaces. Do not remove.
      .eq("workspace_id", input.workspaceId)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .eq("metadata->>dedupe_key", dedupeKey)
      .limit(1);
    if ((prior ?? []).length > 0) return { emitted: false };
  } catch (err) {
    console.warn(
      "[reconnect-required-escalation] prior-card lookup failed (skipping card)",
      { err },
    );
    return { emitted: false };
  }

  const accountsLine =
    (input.affectedAdAccountIds ?? []).length > 0
      ? `Affected ad accounts: ${(input.affectedAdAccountIds ?? []).join(", ")}\n`
      : "";
  const title = "Meta connection needs to be re-authorized — ad spend running unmeasured";
  const body = (
    `Meta has invalidated your stored access token. The per-workspace user credential we use to read ad ` +
    `performance has been marked invalid, so ROAS ingest and the autonomous media-buyer loop are BLIND until you ` +
    `reconnect. Ads are still delivering and spend is still accruing, just UNMEASURED.\n\n` +
    `Fix: open ${META_INTEGRATIONS_RECONNECT_LINK} and reconnect. On the Meta consent screen, keep BOTH ` +
    `\`ads_read\` AND \`ads_management\` granted — dropping either leaves spend sync broken with a different error ` +
    `(both were verified present on the 2026-08-02 recovery).\n\n` +
    `Triggering request: ${input.label}\n` +
    `Message: ${(input.error.message || "").slice(0, 500)}\n` +
    accountsLine +
    `\nRetrying will not fix this — only re-consenting OAuth can. This card dedupes to one per workspace per UTC day, ` +
    `so today's remaining occurrences will collapse here.`
  ).slice(0, 4000);

  try {
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: input.workspaceId,
      type: APPROVAL_REQUEST_TYPE,
      title,
      body,
      link: META_INTEGRATIONS_RECONNECT_LINK,
      metadata: {
        routed_to_function: "ceo",
        escalated_by_director: PLATFORM_DIRECTOR_FUNCTION,
        escalation_kind: "reconnect_required",
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
      console.warn("[reconnect-required-escalation] insert failed", { error, dedupeKey });
      return { emitted: false };
    }
    return { emitted: true };
  } catch (err) {
    console.warn("[reconnect-required-escalation] insert threw", { err, dedupeKey });
    return { emitted: false };
  }
}

/**
 * Default-handler workspace scope. Same non-racy AsyncLocalStorage pattern as
 * the app-owner sibling — two overlapping publishes for different workspaces
 * each see their own scope, closing the module-global race that a prior
 * setter+finally pattern would have.
 */
const workspaceScopeStore = new AsyncLocalStorage<{ workspaceId: string }>();

/**
 * Bind the reconnect_required workspace scope to `workspaceId` for the
 * duration of `fn` (and every await reached from it, transitively). Nested
 * calls shadow the outer scope; overlapping chains see only their own.
 * MUST wrap every await that could raise a Meta `reconnect_required` error.
 */
export function runWithReconnectRequiredWorkspaceScope<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return workspaceScopeStore.run({ workspaceId }, fn);
}

export function getCurrentReconnectRequiredWorkspaceScope(): string | null {
  return workspaceScopeStore.getStore()?.workspaceId ?? null;
}

/**
 * Install the default handler that raises the CEO card when a
 * reconnect_required error fires AND a workspace scope is set. Import from
 * an app-startup path (typically the today-sync inngest function) and run
 * the awaited Graph work inside [[runWithReconnectRequiredWorkspaceScope]]
 * so the handler can resolve the caller's workspace.
 */
export function installDefaultReconnectRequiredEscalationHandler(admin: Admin): void {
  registerReconnectRequiredHandler((ctx: ReconnectRequiredContext) => {
    const workspaceId = getCurrentReconnectRequiredWorkspaceScope();
    if (!workspaceId) return;
    void escalateReconnectRequired(admin, {
      workspaceId,
      label: ctx.label,
      status: ctx.status,
      error: ctx.error,
    });
  });
}
