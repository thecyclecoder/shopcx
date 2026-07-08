/**
 * Enqueue Sol's first-touch ticket-handle box session for a portal-error ticket.
 *
 * Phase 1 of [[../../../docs/brain/specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]]:
 * a portal error now routes to Sol as the first responder — she authors the durable
 * `ticket_directions` row with intent set toward portal-error remediation and delivers the
 * customer fix — instead of the ticket falling through to the auto-healer's `escalate()` →
 * `triage-escalations-cron` → `cs-director-call` June-review path. That June path stays
 * available as Sol's Phase-3 rail hit; it is no longer the default portal-error route.
 *
 * Enqueue shape mirrors the two existing Sol first-touch enqueue sites so `runTicketHandleJob`
 * (scripts/builder-worker.ts) can parse the payload uniformly:
 *   - unified-ticket-handler.ts sends a first_touch enqueue on `is_new_ticket` in the inbound
 *     dispatch path (Phase 3 of sol-ticket-direction-artifact-and-first-touch-box-session).
 *   - inflection-detector.ts sends an `inflection` bounce via `reSessionSol`.
 * This helper is the portal-error sibling — `reason='portal_error'` + the failed portal route +
 * the stable error code, so Sol reads the context in her first-touch prompt and authors a
 * portal-error Direction.
 *
 * Dedupe guard (Learning #2 — confirming predicate before the mutating action, not a coarser
 * proxy): a single portal ticket must not fan out two Sol sessions. Before inserting we query
 * `agent_jobs` for an in-flight (`queued`/`queued_resume`/`claimed`/`building`/`needs_input`)
 * `ticket-handle` job whose `spec_slug=ticket-handle-<first-8-of-ticket-id>` matches; if one
 * exists we skip. Idempotent so the portal route's dedupe (open ticket from the last hour is
 * reused) never doubles up Sol's session on a retry.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** ticket-handle job phases that count as still-live for dedupe. Mirrors triage-escalations-cron. */
const LIVE_JOB_STATUSES = ["queued", "queued_resume", "claimed", "building", "needs_input"] as const;

export interface EnqueueInput {
  workspace_id: string;
  ticket_id: string;
  /** The failed portal route (e.g. `changedate`, `frequency`, `removeLineItem`, `cancel`). */
  route: string;
  /** The stable error code the portal captured (e.g. `would_remove_last_item`, `insufficient_points`). */
  error_code: string | null;
}

export interface EnqueueOutcome {
  enqueued: boolean;
  job_id: string | null;
  /** `already_inflight` (dedupe skip) · `insert_failed` (DB error) · null on success. */
  reason: "already_inflight" | "insert_failed" | null;
}

export function specSlugForTicketHandle(ticket_id: string): string {
  return `ticket-handle-${ticket_id.slice(0, 8)}`;
}

export async function enqueueSolFirstTouchForPortalError(
  admin: SupabaseClient,
  input: EnqueueInput,
): Promise<EnqueueOutcome> {
  const slug = specSlugForTicketHandle(input.ticket_id);

  // Dedupe: skip if an in-flight ticket-handle job already covers this ticket.
  // Same shape triage-escalations-cron uses (spec_slug == ticket dedupe key).
  const { data: inflight, error: inflightErr } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", input.workspace_id)
    .eq("kind", "ticket-handle")
    .eq("spec_slug", slug)
    .in("status", LIVE_JOB_STATUSES as unknown as string[])
    .limit(1);
  if (inflightErr) throw inflightErr;
  if ((inflight ?? []).length > 0) {
    return { enqueued: false, job_id: null, reason: "already_inflight" };
  }

  // No ticket_id column on agent_jobs — the shape is workspace_id + spec_slug + kind +
  // instructions (JSON with the per-kind payload). runTicketHandleJob parses ticket_id +
  // workspace_id from the instructions blob (mirrors ticket-improve's params-in-JSON pattern).
  // turn_index=1: no ack was sent (the portal customer already saw the error UI), so Sol's
  // Direction+first_reply is turn 1 for the ticket_resolution_events ledger.
  const { data: jobRow, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: input.workspace_id,
      kind: "ticket-handle",
      spec_slug: slug,
      status: "queued",
      instructions: JSON.stringify({
        ticket_id: input.ticket_id,
        workspace_id: input.workspace_id,
        turn_index: 1,
        reason: "portal_error",
        route: input.route,
        error_code: input.error_code,
      }),
    })
    .select("id")
    .single();
  if (error || !jobRow) {
    return { enqueued: false, job_id: null, reason: "insert_failed" };
  }
  return { enqueued: true, job_id: (jobRow as { id: string }).id, reason: null };
}
