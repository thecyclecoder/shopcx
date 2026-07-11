/**
 * sol-link-proposal — Phase 2 of
 * [[../specs/account-linking-address-aware-confidence-graded-and-cs-searchable]].
 *
 * Applies the first-class link proposal Sol / June named on the Direction
 * ([[ticket-directions]] `plan.link_proposal`, resolved via `resolveSolLinkProposal`). The
 * write happens BEFORE the remedy dispatch (playbook / journey / stateless refund) so the
 * remedy can target the whole person — the `customer_links` group — instead of dead-ending on
 * the empty half (the db8b3d66 scar Phase 1 detected).
 *
 * The applier is authorized by TWO independently-verifiable predicates:
 *   1. `confidence === 'high'` — Phase 1 [[account-matching]] `gradeUnlinkedCandidates` only
 *      surfaces high when address OR phone corroborates a name match. A `low` proposal is a
 *      surface-only signal for June's judgement; the worker NEVER auto-executes it.
 *   2. If the pair is `previously_rejected`, the proposal MUST also carry `reconfirmed: true`
 *      — the writer's validator ([[ticket-directions]] `validateLinkProposal`) refuses without
 *      it, and this applier re-asserts the invariant so a caller that bypassed the writer
 *      cannot silently overwrite a bulk-name-only rejection.
 *
 * When authorized, the applier UPSERTS the two customer_links rows into one group (idempotent
 * on `customer_id`), stamps an internal `ticket_messages` note with the cited evidence, and —
 * on a re-confirm — DELETES the stale `customer_link_rejections` row so future analysis reads
 * the fresh judgement (no ghost rejection that a future weak matcher could resurface).
 *
 * READ / WRITE surface: `customers` (workspace scope check), `customer_links` (upsert),
 * `customer_link_rejections` (delete on re-confirm), `ticket_messages` (internal note).
 * Pure over the injected admin — the tests exercise it against an in-memory Supabase stub.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TicketDirectionLinkProposal } from "@/lib/ticket-directions";

type Admin = SupabaseClient;

export type SolLinkApplyReason =
  | "linked"
  | "already_linked"
  | "reconfirmed"
  | "needs_reconfirm"
  | "low_confidence_skipped"
  | "candidate_missing"
  | "same_customer"
  | "candidate_not_in_workspace";

export interface SolLinkApplyResult {
  /** True when the two customers end up in the same customer_links group after this call
   *  (whether newly linked or already linked). False on any refusal path. */
  linked: boolean;
  /** The group_id the two customers now share (null when linked=false). */
  group_id: string | null;
  /** Machine-readable outcome — the router stamps this on ticket_resolution_events.reasoning. */
  reason: SolLinkApplyReason;
  /** True when the previously_rejected + reconfirmed=true path fired — the applier deleted the
   *  stale customer_link_rejections row and the internal note names the re-confirm. */
  reconfirm_applied: boolean;
}

export interface ApplySolLinkProposalInput {
  workspaceId: string;
  ticketId: string;
  /** The ticket's own customer_id — the survivor / primary side of the link. */
  ticketCustomerId: string;
  /** The proposal as resolveSolLinkProposal returned it (candidate_customer_id already trimmed). */
  proposal: TicketDirectionLinkProposal;
}

/**
 * Apply the link proposal. Idempotent — a subsequent call on an already-linked pair returns
 * `already_linked` without a second upsert. Never mutates when the proposal fails a guard;
 * the caller reads `reason` and decides whether to surface it (e.g. `low_confidence_skipped`
 * → June's approval lane; `needs_reconfirm` → escalate for a supervisor re-affirm).
 */
export async function applySolLinkProposal(
  admin: Admin,
  input: ApplySolLinkProposalInput,
): Promise<SolLinkApplyResult> {
  const { workspaceId, ticketId, ticketCustomerId, proposal } = input;
  const candidateId = typeof proposal.candidate_customer_id === "string"
    ? proposal.candidate_customer_id.trim()
    : "";
  if (!candidateId) {
    return { linked: false, group_id: null, reason: "candidate_missing", reconfirm_applied: false };
  }
  if (candidateId === ticketCustomerId) {
    return { linked: false, group_id: null, reason: "same_customer", reconfirm_applied: false };
  }
  if (proposal.confidence !== "high") {
    // Low-confidence proposal — Phase 2 auto-execution is HIGH only. The proposal is preserved
    // on the Direction so June can review it, but the worker never auto-links.
    return { linked: false, group_id: null, reason: "low_confidence_skipped", reconfirm_applied: false };
  }
  if (proposal.previously_rejected === true && proposal.reconfirmed !== true) {
    // Re-asserted here even though the writer already refused — a caller that bypassed the
    // writer with a raw upsert cannot silently overwrite the rejection.
    return { linked: false, group_id: null, reason: "needs_reconfirm", reconfirm_applied: false };
  }

  const { data: candidateRow, error: candErr } = await admin
    .from("customers")
    .select("id, email")
    .eq("workspace_id", workspaceId)
    .eq("id", candidateId)
    .maybeSingle();
  if (candErr) throw candErr;
  if (!candidateRow) {
    return { linked: false, group_id: null, reason: "candidate_not_in_workspace", reconfirm_applied: false };
  }
  const candidate = candidateRow as { id: string; email: string | null };

  const { data: ticketCustomerRow, error: ownErr } = await admin
    .from("customers")
    .select("id, email")
    .eq("workspace_id", workspaceId)
    .eq("id", ticketCustomerId)
    .maybeSingle();
  if (ownErr) throw ownErr;
  const ownEmail = ((ticketCustomerRow as { id: string; email: string | null } | null)?.email) ?? null;

  const { data: primaryLink, error: primErr } = await admin
    .from("customer_links")
    .select("group_id, is_primary")
    .eq("customer_id", ticketCustomerId)
    .maybeSingle();
  if (primErr) throw primErr;
  const { data: dupLink, error: dupErr } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", candidateId)
    .maybeSingle();
  if (dupErr) throw dupErr;

  const primaryGroup = (primaryLink as { group_id: string | null } | null)?.group_id ?? null;
  const dupGroup = (dupLink as { group_id: string | null } | null)?.group_id ?? null;
  const reconfirmApplied = proposal.previously_rejected === true && proposal.reconfirmed === true;

  if (primaryGroup && dupGroup && primaryGroup === dupGroup) {
    // Idempotent — the pair is already in one group. Nothing to write. On a re-confirm we
    // still clear the stale rejection so a future weak matcher doesn't reintroduce it.
    if (reconfirmApplied) {
      await admin
        .from("customer_link_rejections")
        .delete()
        .eq("customer_id", ticketCustomerId)
        .eq("rejected_customer_id", candidateId);
    }
    return {
      linked: true,
      group_id: primaryGroup,
      reason: reconfirmApplied ? "reconfirmed" : "already_linked",
      reconfirm_applied: reconfirmApplied,
    };
  }

  // Merge into one group. If neither side is in a group yet, generate a new group_id; if one
  // side is, reuse THAT one so we merge the other in (so existing rollups keep working).
  const { randomUUID } = await import("crypto");
  const groupId = primaryGroup || dupGroup || randomUUID();
  if (!primaryLink) {
    await admin
      .from("customer_links")
      .upsert(
        { customer_id: ticketCustomerId, workspace_id: workspaceId, group_id: groupId, is_primary: true },
        { onConflict: "customer_id" },
      );
  } else if (!primaryGroup || primaryGroup !== groupId) {
    await admin
      .from("customer_links")
      .update({ group_id: groupId, is_primary: true })
      .eq("customer_id", ticketCustomerId);
  }
  await admin
    .from("customer_links")
    .upsert(
      { customer_id: candidateId, workspace_id: workspaceId, group_id: groupId, is_primary: false },
      { onConflict: "customer_id" },
    );

  if (reconfirmApplied) {
    await admin
      .from("customer_link_rejections")
      .delete()
      .eq("customer_id", ticketCustomerId)
      .eq("rejected_customer_id", candidateId);
  }

  const evidence = [
    `confidence=${proposal.confidence}`,
    proposal.signals && proposal.signals.length > 0 ? `signals=[${proposal.signals.join(",")}]` : null,
    reconfirmApplied ? "re-confirmed (previous rejection cleared)" : null,
    proposal.reason ? `reason=${proposal.reason}` : null,
  ].filter(Boolean).join(" · ");

  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: `[System] Sol/June link proposal applied — linked ${candidate.email ?? candidateId} → primary ${ownEmail ?? ticketCustomerId} (${evidence || "no evidence provided"}).`,
  });

  return {
    linked: true,
    group_id: groupId,
    reason: reconfirmApplied ? "reconfirmed" : "linked",
    reconfirm_applied: reconfirmApplied,
  };
}
