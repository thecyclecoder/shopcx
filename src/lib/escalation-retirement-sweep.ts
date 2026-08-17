/**
 * escalation-retirement-sweep — Phase 2 of
 * [[../../docs/brain/specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]].
 *
 * A standing pass that re-evaluates each OPEN, retirable CEO escalation against its recorded
 * `metadata.retire_when` descriptor and DISMISSES the ones whose condition is provably gone —
 * with the evidence recorded, never a bare clear.
 *
 * INVARIANTS
 *
 * - **Reuses [[agents/approvals-feed]] `buildApprovalsFeed`** filtered to `source==='pending' &&
 *   escalated` so the sweep evaluates EXACTLY the set the founder sees. If the two diverge, the
 *   sweep is retiring things that were never in the inbox.
 *
 * - **Skip non-retirable + absent descriptors.** `isRetirable(readEscalationRecheckDescriptor(meta))`
 *   is false ⇒ leave. That is the fail-closed contract (Phase 1 SDK): a card with no descriptor
 *   or an explicit `non_retirable` shape (a founder yes/no) is NEVER touched.
 *
 * - **Retire ONLY on positive proof of healing.** A DB error, a timeout, an unreadable row is
 *   treated as "cannot re-check" and the card stays exactly where it is. Errors never trip a
 *   retirement — the wrong-conservative outcome (a card sits a little longer) is always preferable
 *   to the wrong-aggressive one (a card retires while the underlying condition is still true).
 *
 * - **Dismiss + record evidence, never a bare clear.** A retirement writes `dismissed=true` +
 *   patches `metadata.retire_reason` + `metadata.retire_evidence` + `metadata.retired_at`, AND
 *   writes ONE [[../tables/director_activity]] row under the RAISING director's function so the
 *   founder can audit "what did it retire, and was it right?" from the ledger alone.
 *
 * - **Never DECIDES the underlying action.** Dismiss clears the card; it does not approve or
 *   decline anything. If a card carries pending actions that are still actionable, it is by
 *   definition not healed — leave it (guarded by the retirable-descriptor gate at raise time).
 *
 * - **Rate-limited per pass.** Bounded by `RETIREMENT_SWEEP_CAP_PER_PASS` so a sudden 20-card
 *   retirement is visible in the standing-pass note rather than discovered later; the count of
 *   retired cards is returned so `runPlatformDirectorStandingPass` can push it into `notes`.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_STATUSES } from "@/lib/agent-jobs";
import { buildApprovalsFeed } from "@/lib/agents/approvals-feed";
import { recordDirectorActivity } from "@/lib/director-activity";
import {
  RETIRE_WHEN_METADATA_KEY,
  isRetirable,
  readEscalationRecheckDescriptor,
  type EscalationRecheckDescriptor,
} from "@/lib/escalation-recheck";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Per-pass ceiling. A legitimate healed-card backlog is small; a large one means the raise side
 * is emitting cards that heal instantly (a bug the founder should see, not a silent auto-clear).
 */
export const RETIREMENT_SWEEP_CAP_PER_PASS = 50;

/** Every card retired in a pass. `evidenceReason` is what the founder sees on the audit ledger. */
export interface RetirementSweepResult {
  /** How many pending+escalated cards the sweep considered (includes non-retirable skips). */
  scanned: number;
  /** notification.id + a short evidence line per retirement — for the standing-pass note. */
  retired: Array<{ notificationId: string; evidenceReason: string }>;
  /** Any card the sweep couldn't re-check (DB error, missing row) — left in place. */
  unreadable: number;
}

/** Pure decision helper — given the descriptor + current DB state, decide whether to retire. */
export type RetireDecision =
  | { retire: true; evidenceReason: string; evidence: Record<string, unknown> }
  | { retire: false; reason: string };

/**
 * The current DB state a decision needs. Batched-read outside so the decision helper stays pure
 * and unit-testable. Undefined ⇒ the reader couldn't fetch it (leave the card alone).
 */
export interface CurrentStateForRetireCheck {
  /** For `ticket_terminal`: the ticket's status (lowercase) — undefined if the row isn't readable. */
  ticketStatus?: string;
  /** For `job_terminal`: the agent_jobs row's current status — undefined if unreadable. */
  jobStatus?: string;
  /** For `action_satisfied` (subscription_exists): any active subscription id for the customer. */
  activeSubscriptionId?: string | null;
  /** For `action_satisfied` (order_exists): any order id for the customer. */
  orderId?: string | null;
}

/**
 * Pure — decide whether the descriptor's condition is satisfied by the current state. Used by
 * `retireHealedEscalations` AND unit-tested standalone so the "positive proof of healing"
 * contract is exercised without a Supabase seam.
 */
export function decideRetirement(
  descriptor: EscalationRecheckDescriptor,
  state: CurrentStateForRetireCheck,
): RetireDecision {
  switch (descriptor.kind) {
    case "non_retirable":
      return { retire: false, reason: "descriptor is non_retirable" };
    case "ticket_terminal": {
      if (state.ticketStatus === undefined) {
        return { retire: false, reason: "ticket row unreadable — cannot re-check" };
      }
      // status='closed' is the terminal signal. The tickets brain page pins that escalated_at is
      // cleared to null on transition to closed, so a closed ticket is by construction "not
      // escalated" — one check suffices, and cannot false-positive on a re-escalated live ticket.
      if (state.ticketStatus === "closed") {
        return {
          retire: true,
          evidenceReason: `linked ticket ${descriptor.ticket_id.slice(0, 8)} is closed`,
          evidence: { kind: "ticket_terminal", ticket_id: descriptor.ticket_id, ticket_status: "closed" },
        };
      }
      return { retire: false, reason: `ticket still ${state.ticketStatus}` };
    }
    case "job_terminal": {
      if (state.jobStatus === undefined) {
        return { retire: false, reason: "agent_jobs row unreadable — cannot re-check" };
      }
      const isLive = (ACTIVE_STATUSES as readonly string[]).includes(state.jobStatus) || state.jobStatus === "needs_attention";
      if (!isLive) {
        return {
          retire: true,
          evidenceReason: `parked job ${descriptor.agent_job_id.slice(0, 8)} left needs_attention (status=${state.jobStatus})`,
          evidence: { kind: "job_terminal", agent_job_id: descriptor.agent_job_id, job_status: state.jobStatus },
        };
      }
      return { retire: false, reason: `job still ${state.jobStatus}` };
    }
    case "action_satisfied": {
      if (descriptor.action === "subscription_exists") {
        if (state.activeSubscriptionId === undefined) {
          return { retire: false, reason: "subscriptions read unreachable — cannot re-check" };
        }
        if (state.activeSubscriptionId) {
          return {
            retire: true,
            evidenceReason: `customer ${descriptor.customer_id.slice(0, 8)} now has active subscription ${state.activeSubscriptionId.slice(0, 8)}`,
            evidence: {
              kind: "action_satisfied",
              action: "subscription_exists",
              customer_id: descriptor.customer_id,
              subscription_id: state.activeSubscriptionId,
            },
          };
        }
        return { retire: false, reason: "customer has no active subscription yet" };
      }
      if (descriptor.action === "order_exists") {
        if (state.orderId === undefined) {
          return { retire: false, reason: "orders read unreachable — cannot re-check" };
        }
        if (state.orderId) {
          return {
            retire: true,
            evidenceReason: `customer ${descriptor.customer_id.slice(0, 8)} now has order ${state.orderId.slice(0, 8)}`,
            evidence: {
              kind: "action_satisfied",
              action: "order_exists",
              customer_id: descriptor.customer_id,
              order_id: state.orderId,
            },
          };
        }
        return { retire: false, reason: "customer has no order yet" };
      }
      return { retire: false, reason: "unknown action_satisfied action" };
    }
  }
}

/**
 * Read the state a single descriptor needs from the DB. Best-effort — a read error leaves the
 * relevant field `undefined` so `decideRetirement` treats it as "cannot re-check" and fails
 * closed. Each shape reads only what IT needs; a `ticket_terminal` descriptor doesn't hit
 * subscriptions.
 */
async function readCurrentState(
  admin: Admin,
  workspaceId: string,
  descriptor: EscalationRecheckDescriptor,
): Promise<CurrentStateForRetireCheck> {
  const state: CurrentStateForRetireCheck = {};
  try {
    if (descriptor.kind === "ticket_terminal") {
      const { data, error } = await admin
        .from("tickets")
        .select("status")
        .eq("id", descriptor.ticket_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (!error && data) state.ticketStatus = (data.status as string | null) ?? undefined;
    } else if (descriptor.kind === "job_terminal") {
      const { data, error } = await admin
        .from("agent_jobs")
        .select("status")
        .eq("id", descriptor.agent_job_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (!error && data) state.jobStatus = (data.status as string | null) ?? undefined;
    } else if (descriptor.kind === "action_satisfied") {
      if (descriptor.action === "subscription_exists") {
        const { data, error } = await admin
          .from("subscriptions")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("customer_id", descriptor.customer_id)
          .eq("status", "active")
          .limit(1);
        if (!error) state.activeSubscriptionId = (data?.[0]?.id as string | undefined) ?? null;
      } else if (descriptor.action === "order_exists") {
        const { data, error } = await admin
          .from("orders")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("customer_id", descriptor.customer_id)
          .limit(1);
        if (!error) state.orderId = (data?.[0]?.id as string | undefined) ?? null;
      }
    }
  } catch (e) {
    console.warn(
      `[escalation-retirement-sweep] readCurrentState(${descriptor.kind}) threw:`,
      e instanceof Error ? e.message : e,
    );
  }
  return state;
}

/**
 * The Phase 2 sweep entrypoint. Reads the SAME feed the founder sees (pending + escalated) via
 * `buildApprovalsFeed`, evaluates each retirable card against its `retire_when` descriptor's
 * current state, and DISMISSES the ones whose condition is provably healed — patching the
 * notification's metadata with retire reason + evidence, writing one `director_activity` row per
 * retirement under the raising director's function.
 *
 * Bounded by `RETIREMENT_SWEEP_CAP_PER_PASS`; a pass that reaches the cap logs it in the summary
 * so a sudden burst is visible. Idempotent — once dismissed, the card is no longer in the feed.
 */
export async function retireHealedEscalations(
  admin: Admin,
  workspaceId: string,
): Promise<RetirementSweepResult> {
  const result: RetirementSweepResult = { scanned: 0, retired: [], unreadable: 0 };

  const feed = await buildApprovalsFeed(admin, workspaceId);
  const candidates = feed.items.filter((it) => it.source === "pending" && it.escalated);
  result.scanned = candidates.length;

  // Pull the full notification rows for the candidates — buildApprovalsFeed doesn't return the
  // raw `metadata` blob (it's already enriched into typed fields), so we re-fetch the metadata
  // for the exact ids the founder sees. If the row got dismissed between the feed build and this
  // fetch, `.maybeSingle()` returns null and we skip it (idempotent).
  const notifIds = candidates.map((c) => c.id);
  if (notifIds.length === 0) return result;

  const { data: notifs, error: readErr } = await admin
    .from("dashboard_notifications")
    .select("id, metadata, created_at")
    .in("id", notifIds)
    .eq("dismissed", false);
  if (readErr || !notifs) {
    console.warn(
      `[escalation-retirement-sweep] batch metadata read failed:`,
      readErr?.message ?? "no rows",
    );
    return result;
  }

  const notifById = new Map<string, { metadata: Record<string, unknown> | null; created_at: string }>();
  for (const n of notifs as Array<{ id: string; metadata: Record<string, unknown> | null; created_at: string }>) {
    notifById.set(n.id, { metadata: n.metadata, created_at: n.created_at });
  }

  for (const card of candidates) {
    if (result.retired.length >= RETIREMENT_SWEEP_CAP_PER_PASS) break;
    const row = notifById.get(card.id);
    if (!row) continue; // dismissed between feed build + re-read; leave it
    const descriptor = readEscalationRecheckDescriptor(row.metadata);
    if (!isRetirable(descriptor)) continue; // absent / non_retirable / malformed → leave (fail-closed)
    if (!descriptor) continue; // exhaustive — isRetirable(null)=false above; TS narrowing

    const state = await readCurrentState(admin, workspaceId, descriptor);
    const decision = decideRetirement(descriptor, state);
    if (!decision.retire) {
      // A read that came back undefined is 'unreadable' bookkeeping; a well-formed 'not-yet-healed'
      // is business-as-usual (still open).
      const wasUnreadable = /unreadable|unreachable/i.test(decision.reason);
      if (wasUnreadable) result.unreadable += 1;
      continue;
    }

    // Compose the metadata patch — keep the original body/reasoning; add retire_reason +
    // retire_evidence + retired_at so the founder can audit what left and why.
    const raisedByDirector =
      typeof row.metadata?.["escalated_by_director"] === "string"
        ? (row.metadata!["escalated_by_director"] as string)
        : "platform";
    const nowIso = new Date().toISOString();
    const patch = {
      ...(row.metadata ?? {}),
      [RETIRE_WHEN_METADATA_KEY]: descriptor,
      retire_reason: decision.evidenceReason,
      retire_evidence: decision.evidence,
      retired_at: nowIso,
    };

    const { error: updErr } = await admin
      .from("dashboard_notifications")
      .update({ dismissed: true, metadata: patch })
      .eq("id", card.id)
      .eq("dismissed", false)
      .select("id");
    if (updErr) {
      console.warn(
        `[escalation-retirement-sweep] dismiss failed for ${card.id}:`,
        updErr.message,
      );
      continue;
    }

    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: raisedByDirector,
      actionKind: "retired_escalation",
      specSlug: card.spec?.slug ?? null,
      reason: `Retired healed escalation — ${decision.evidenceReason}. Original: ${card.title}`,
      metadata: {
        notification_id: card.id,
        escalation_kind: typeof row.metadata?.["escalation_kind"] === "string" ? row.metadata!["escalation_kind"] : null,
        retire_evidence: decision.evidence,
        retire_reason: decision.evidenceReason,
        autonomous: true,
      },
    });

    result.retired.push({ notificationId: card.id, evidenceReason: decision.evidenceReason });
  }

  return result;
}
