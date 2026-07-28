/**
 * dead-verb-escalation — the CEO-facing surface for a Meta capability that
 * VANISHED. When [[./graph-retry]] classifies a response as
 * [[./graph-retry]] `isPermanentGraphError` (Meta removed the endpoint we
 * depended on), this SDK raises a deduped `dashboard_notifications` card that
 * names both the CALLING FUNCTION (from the label passed to `graphFetchJson`)
 * and the CAPABILITY LOST (the meta code + subcode + canonical message).
 *
 * The point is turning "an autonomous rail silently did nothing for weeks
 * because its endpoint was removed" into "the next occurrence is a message,
 * not an archaeology exercise" — the exact incident the CEO caught on
 * 2026-07-27 when the ASC-removal (code `100` subcode `2490568`) sat undetected
 * because the cold-scaler minting function had no live caller.
 *
 * Wiring: this module registers itself against [[./graph-retry]] at import
 * time via `registerPermanentGraphErrorHandler`. The handler is fire-and-forget
 * (graph-retry stays pure, DB-free, and unit-testable); a DB write failure is
 * swallowed and logged so a broken escalation never masks the underlying
 * permanent throw.
 *
 * Dedupe: at most one card per (workspace, capabilitySignature, UTC day) where
 * `capabilitySignature` is the `metaCode:metaSubcode` pair (or a hash of the
 * label when the pair is missing). A persistent removed endpoint therefore
 * surfaces at most once per day per workspace, not once per retry.
 *
 * Introduced by [[../../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]]
 * Phase 2.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";
import {
  type GraphError,
  registerPermanentGraphErrorHandler,
  type PermanentGraphErrorContext,
} from "@/lib/meta/graph-retry";

type Admin = ReturnType<typeof createAdminClient>;

/** Deep link the dead-verb escalation surfaces on the CEO's inbox card. */
const DEAD_VERB_ESCALATION_DEEP_LINK = "/dashboard/marketing/ads";

/** Owner function — Growth owns the Meta-marketing surface. */
const GROWTH_DIRECTOR_FUNCTION = "growth";

export interface EscalateDeadMetaVerbInput {
  workspaceId: string;
  /**
   * The endpoint label passed to `graphFetchJson` — typically
   * `"GET act_.../campaigns"` or `"POST act_.../ads"`. Used verbatim in the
   * card body so the CEO can see WHICH request tripped the removal.
   */
  label: string;
  /** HTTP status Meta returned (typically 400 on a code-100 removal). */
  status: number;
  /** The tagged `GraphError` — carries `metaCode` / `metaSubcode` / message. */
  error: GraphError;
  /**
   * Optional caller-supplied capability name — e.g. `"cold_scaler_campaign_mint"`
   * or `"advantage_plus_shopping_campaign_creation"`. When omitted, we
   * synthesize one from `metaCode:metaSubcode` (falling back to the label).
   */
  capability?: string;
  /**
   * Optional calling-function name — e.g.
   * `"media-buyer-agent runGraduateForCrownedWinners"`. When omitted, we use
   * the label. Named separately from `label` so a caller that has both a
   * label ("GET .../campaigns") AND a meaningful function name can include
   * both in the card without one clobbering the other.
   */
  callingFunction?: string;
  /** Override "now" — tests pin this so the dedupe day is deterministic. */
  nowMs?: number;
}

export interface EscalateDeadMetaVerbResult {
  emitted: boolean;
}

/**
 * Build the human-readable capability signature used in the dedupe key. Two
 * throws in the SAME UTC day naming the SAME code:subcode collapse to one
 * card; a different removed endpoint (different code:subcode) surfaces
 * independently.
 */
export function deadVerbCapabilitySignature(err: GraphError, fallbackLabel: string): string {
  const code = typeof err.metaCode === "number" ? err.metaCode : Number(err.metaCode);
  const subcode =
    typeof err.metaSubcode === "number" ? err.metaSubcode : Number(err.metaSubcode);
  if (Number.isFinite(code) && Number.isFinite(subcode)) {
    return `meta_${code}_${subcode}`;
  }
  if (Number.isFinite(code)) return `meta_${code}`;
  // No code — fall back to the label (already stable per call site).
  return `label:${fallbackLabel}`;
}

/**
 * Raise the CEO card. Idempotent per (workspace, capability, UTC day) — the
 * confirming predicate is `metadata->>dedupe_key`, and we insert only after
 * the SELECT returns zero rows. Returns `{emitted:false}` on a same-day
 * duplicate or a DB write failure (write failures are logged, never rethrown —
 * an escalation SDK that CAN throw would drop the caller into a nested error
 * path just as the CEO card was supposed to make things easier).
 */
export async function escalateDeadMetaVerb(
  admin: Admin,
  input: EscalateDeadMetaVerbInput,
): Promise<EscalateDeadMetaVerbResult> {
  const day = new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10);
  const capabilitySignature =
    input.capability ?? deadVerbCapabilitySignature(input.error, input.label);
  const dedupeKey = `dead_meta_verb:${input.workspaceId}:${capabilitySignature}:${day}`;

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
    console.warn("[dead-verb-escalation] prior-card lookup failed (skipping card)", { err });
    return { emitted: false };
  }

  const callerLabel = input.callingFunction ?? input.label;
  const code = typeof input.error.metaCode === "number" ? input.error.metaCode : "?";
  const subcode =
    typeof input.error.metaSubcode === "number" ? input.error.metaSubcode : "?";
  const title = `Meta capability removed: ${capabilitySignature} — ${callerLabel}`.slice(0, 200);
  const body = (
    `Meta returned a permanent-class error for ${callerLabel} — the API surface it depends on has been removed.\n` +
    `Meta code ${code} subcode ${subcode} on HTTP ${input.status}.\n` +
    `Message: ${(input.error.message || "").slice(0, 500)}\n\n` +
    `Never-retry: this endpoint won't return. A code change is required — swap ` +
    `${callerLabel} to the current supported surface, or retire the capability. ` +
    `The next occurrence of this signature (${capabilitySignature}) collapses ` +
    `to this same card for the rest of the UTC day.`
  ).slice(0, 4000);

  try {
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: input.workspaceId,
      type: APPROVAL_REQUEST_TYPE,
      title,
      body,
      link: DEAD_VERB_ESCALATION_DEEP_LINK,
      metadata: {
        routed_to_function: "ceo",
        escalated_by_director: GROWTH_DIRECTOR_FUNCTION,
        escalation_kind: "dead_meta_verb",
        capability_signature: capabilitySignature,
        calling_function: callerLabel,
        meta_code: Number.isFinite(Number(input.error.metaCode)) ? Number(input.error.metaCode) : null,
        meta_subcode: Number.isFinite(Number(input.error.metaSubcode))
          ? Number(input.error.metaSubcode)
          : null,
        http_status: input.status,
        meta_message: (input.error.message || "").slice(0, 2000),
        dedupe_key: dedupeKey,
        approve_action_id: null,
      },
      read: false,
      dismissed: false,
    });
    if (error) {
      console.warn("[dead-verb-escalation] insert failed", { error, dedupeKey });
      return { emitted: false };
    }
    return { emitted: true };
  } catch (err) {
    console.warn("[dead-verb-escalation] insert threw", { err, dedupeKey });
    return { emitted: false };
  }
}

/**
 * The default handler installed on [[./graph-retry]] at import time. Requires
 * a workspace scope to write the card, but `graphFetchJson` doesn't know the
 * calling workspace — so this handler is a no-op unless the caller has
 * pre-set the current workspace via [[setCurrentDeadVerbWorkspaceScope]]
 * (typically at a request/pass boundary) OR a dedicated caller has installed
 * a workspace-carrying handler via
 * [[registerPermanentGraphErrorHandler]] directly. Either way, the CLASS
 * information is preserved on the thrown `GraphError` (`metaClass`), so a
 * caller that catches the throw can also escalate through this SDK using
 * [[escalateDeadMetaVerb]] explicitly.
 */
let currentWorkspaceScope: string | null = null;

export function setCurrentDeadVerbWorkspaceScope(workspaceId: string | null): void {
  currentWorkspaceScope = workspaceId;
}

export function getCurrentDeadVerbWorkspaceScope(): string | null {
  return currentWorkspaceScope;
}

/**
 * Install the default handler that raises the CEO card when a permanent-class
 * error fires AND a workspace scope is set. Import from an app-startup path
 * (e.g. an Inngest function, the media-buyer runner) after wiring the workspace
 * scope for the caller — this file's default export re-installs on every
 * module import as a belt-and-suspenders convenience.
 */
export function installDefaultDeadVerbEscalationHandler(admin: Admin): void {
  registerPermanentGraphErrorHandler((ctx: PermanentGraphErrorContext) => {
    const workspaceId = currentWorkspaceScope;
    if (!workspaceId) return;
    void escalateDeadMetaVerb(admin, {
      workspaceId,
      label: ctx.label,
      status: ctx.status,
      error: ctx.error,
    });
  });
}
