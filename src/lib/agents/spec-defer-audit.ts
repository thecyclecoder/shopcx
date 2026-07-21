/**
 * spec-defer-audit — the ONE audited+surfaced path for any PROGRAMMATIC (non-human) spec deferral.
 *
 * ⭐ The no-silent-spec-defer invariant (CEO directive, supervisable autonomy). A spec parked to
 * `deferred` by an autonomous flow with NO audit row + NO CEO surface is a supervisability gap: the
 * CEO can't tell WHO parked it or WHY, and can't one-click un-defer it. (Observed live: the weekly
 * kpi-drift loop-repair spec `kpi-audit-regression-coverage-current-state` was flipped to deferred by
 * the loop/repair flow via a direct status write — no `director_activity`, no notification — and the
 * CEO couldn't tell it wasn't his director who did it.)
 *
 * Ada's dispose-downgrade already had the right shape (`spec-dispose.ts`: `applyAdaDisposition` →
 * `director_activity(spec_dispose_downgrade)` + `emitDeferNotification`). This module GENERALIZES that
 * shape so EVERY programmatic defer reuses it, and exposes the CEO-notification primitive Ada's lane
 * reuses too (one notification surface, one dedupe convention).
 *
 * The ONLY exempt defer is the CEO's own dashboard action (`POST /api/roadmap/priority` → actor
 * `owner:{user.id}`) — a deliberate human action that already carries provenance via `spec_status_history`.
 * Every NON-human defer goes through `auditedProgrammaticDefer` here.
 *
 * Contract for a caller:
 *   - `actor`: a CONCRETE actor string (e.g. `director:platform`, `loop-repair:<signature>`, `worker:bo`).
 *   - `reason`: a CONCRETE plain-text why. For a loop/repair defer name the loop/signature AND the WHY
 *     (resolved / superseded / pending-deploy) — never a generic "deferred this".
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { markSpecCardDeferred } from "@/lib/spec-card-state";
import { recordDirectorActivity } from "@/lib/director-activity";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";

type Admin = ReturnType<typeof createAdminClient>;

/** The CEO function slug — every defer notification routes to the CEO's agent inbox. */
const CEO = "ceo";

export interface AuditedDeferInput {
  admin: Admin;
  workspaceId: string;
  slug: string;
  /** CONCRETE actor that parked it (e.g. `director:platform`, `loop-repair:loop:kpi_drift:…`, `worker:bo`). */
  actor: string;
  /**
   * The function whose objective owns/supervises the action — the `director_activity.director_function`.
   * For a director chat-flip this is the emitting director; for a loop-repair defer it's the supervising
   * function (default `platform` — Ada supervises the Control Tower / repair loop).
   */
  directorFunction: string;
  /** CONCRETE plain-text why (loop/signature + resolved/superseded/pending-deploy for a loop-repair defer). */
  reason: string;
  /** structured context: { signature?, loop_id?, kind?, job_id?, … } — carried onto the audit row + notif. */
  metadata?: Record<string, unknown>;
  /** Skip the CEO notification (used by callers that surface the defer through their own card, e.g. Ada's
   *  dispose lane which keeps its `ada-downgrade:` dedupe key). Defaults to false — surface by default. */
  skipNotification?: boolean;
}

export interface AuditedDeferResult {
  ok: boolean;
  /** whether the `director_activity` row landed. */
  audited: boolean;
  /** whether the CEO notification landed (or was deduped / skipped). */
  surfaced: boolean;
  reason?: string;
}

/**
 * Park a spec to `deferred` PROGRAMMATICALLY with full provenance: (1) flip `flags.deferred` via the
 * standard `markSpecCardDeferred` writer (appends a `spec_status_history` row stamped `actor`+`reason`),
 * (2) record a `director_activity(spec_deferred_programmatic)` audit row (who + why + metadata), and
 * (3) emit a CEO "Spec deferred — <why>" notification with a one-click un-defer deep-link.
 *
 * Best-effort + never throws: the card flip is the load-bearing write; an audit-row or notification
 * failure logs a warning but never blocks the park (the deep-link surface still resolves). Returns flags
 * so the caller can log whether the full audit+surface landed.
 */
export async function auditedProgrammaticDefer(input: AuditedDeferInput): Promise<AuditedDeferResult> {
  const { admin, workspaceId, slug, actor, directorFunction, metadata, skipNotification } = input;
  const reason = (input.reason || "").slice(0, 1000) || `Programmatically deferred by ${actor} (no reason given).`;

  // (1) The load-bearing flip — park the card. This appends the spec_status_history audit row.
  try {
    await markSpecCardDeferred(workspaceId, slug, true, { actor, reason });
  } catch (err) {
    const msg = errText(err);
    console.warn(`[spec-defer-audit] markSpecCardDeferred failed for ${slug}:`, msg);
    return { ok: false, audited: false, surfaced: false, reason: msg };
  }

  // (2) The director_activity audit row — WHO + WHY, so the recap/ledger reads back the actor + reason.
  const act = await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction,
    actionKind: "spec_deferred_programmatic",
    specSlug: slug,
    reason,
    metadata: { ...(metadata ?? {}), actor, programmatic: true, surfaced: !skipNotification },
  });

  // (3) The CEO notification — "Spec deferred — <why>" with one-click un-defer.
  let surfaced = !!skipNotification; // a skipped surface still counts as "handled" (caller surfaces it).
  if (!skipNotification) {
    const notif = await emitDeferNotification(admin, workspaceId, slug, actor, reason);
    surfaced = notif.ok;
  }

  return { ok: true, audited: act.recorded, surfaced };
}

/**
 * Emit ONE CEO notification on a spec defer: "Spec deferred — <why>" routed to the CEO's agent inbox,
 * deep-linking to the spec card where the existing un-defer / Build affordances live (one-click override).
 * Deduped on `metadata.dedupe_key=spec-defer:{slug}`. Reused by Ada's dispose-downgrade lane too (it
 * passes its own `dedupeKey` so the two surfaces don't collide). Best-effort — returns `{ok}` and warns
 * on failure but never throws.
 */
export async function emitDeferNotification(
  admin: Admin,
  workspaceId: string,
  slug: string,
  actor: string,
  reason: string,
  opts?: { dedupeKey?: string; escalationKind?: string; bodyPrefix?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const dedupeKey = opts?.dedupeKey ?? `spec-defer:${slug}`;
  const escalationKind = opts?.escalationKind ?? "spec_deferred_programmatic";
  try {
    const { data: prior } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .eq("metadata->>dedupe_key", dedupeKey)
      .limit(1);
    if ((prior ?? []).length > 0) return { ok: true, reason: "deduped" };

    const prefix = opts?.bodyPrefix ?? `🅿️ Spec deferred by ${actor} — want it built now? Override on the spec card.`;
    const body = `${prefix}\n${reason}`.slice(0, 4000);
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId,
      type: APPROVAL_REQUEST_TYPE,
      title: `Spec deferred — ${slug}`,
      body,
      link: `/dashboard/roadmap/${slug}`,
      metadata: {
        routed_to_function: CEO,
        escalation_kind: escalationKind,
        escalation_reason: reason.slice(0, 2000),
        deferred_by: actor,
        dedupe_key: dedupeKey,
        spec_slug: slug,
        deep_link: `/dashboard/roadmap/${slug}`,
        approve_action_id: null,
      },
      read: false,
      dismissed: false,
    });
    if (error) {
      console.warn(`[spec-defer-audit] defer notification insert failed for ${slug}:`, error.message);
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  } catch (err) {
    const msg = errText(err);
    console.warn(`[spec-defer-audit] emitDeferNotification threw for ${slug}:`, msg);
    return { ok: false, reason: msg };
  }
}
