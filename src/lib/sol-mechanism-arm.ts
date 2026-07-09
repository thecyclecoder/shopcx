/**
 * sol-mechanism-arm — the box session's reply-gated arm of the mechanism Sol chose.
 *
 * Founder directive (2026-07-09): Sol's first-touch box session writes the opening reply, and
 * the chosen playbook must then be ARMED so it takes over on the customer's NEXT reply — never
 * dormant (waiting on a reply that may never arm it) and never double-sending (Sol's opening +
 * the playbook's first message at once).
 *
 * Playbooks are the mechanism the inbound handler drives on a customer REPLY (the
 * `sol-playbook-shortcircuit` in [[../inngest/unified-ticket-handler]] runs `executePlaybookStep`
 * when `tickets.active_playbook_id` is set). So arming = `armPlaybook` (a pure state-set, sends
 * nothing — [[tickets-mutate]]). That makes it reply-gated by construction: no message ships until
 * marty's next inbound drives the armed step.
 *
 * The RESUME step is the crux. Sol's opening reply already delivered the playbook's customer-facing
 * "explain / stand-firm" step (the `apply_policy` step) plus the silent identify/check steps before
 * it. Re-running those on the next reply would repeat Sol's message. So we arm at the step AFTER the
 * leading identify/check/apply_policy prefix — the first real offer/action step (e.g. `offer_exception`
 * on the refund playbook) — and seed the identified order/subscription context those skipped steps
 * would have populated, so the offer/return steps have what they need.
 *
 * Journeys are NOT driven by replies — they're self-service CTA flows the customer advances by
 * clicking a token-authed button. "Arming" a journey therefore means Sol's opening must CARRY the
 * CTA (a send-path change), not a silent reply-gated state-set. That case is deliberately out of
 * scope here and handled on the send path.
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import { armPlaybook } from "@/lib/tickets-mutate";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Step types Sol's opening reply covers (the leading, contiguous prefix of a playbook):
 * the silent identify/check steps plus the single customer-facing `apply_policy` explanation.
 * The playbook resumes at the first step AFTER this prefix.
 */
export const OPENING_PREFIX_STEP_TYPES = new Set<string>([
  "identify_order",
  "identify_subscription",
  "identify_customer",
  "check_other_subscriptions",
  "apply_policy",
]);

export interface ArmPlaybookArgs {
  workspaceId: string;
  ticketId: string;
  playbookSlug: string;
  /** Sol's `plan.playbook_seed_context` (order/sub/customer ids), if she provided one. */
  seedContext?: Record<string, unknown> | null;
}

export interface ArmPlaybookResult {
  armed: boolean;
  playbookId: string | null;
  resumeStep: number | null;
  reason:
    | "armed"
    | "playbook_not_found"
    | "no_steps"
    | "no_post_opening_step"
    | "already_active";
}

/**
 * Compute the resume step: the count of leading steps whose type is in
 * {@link OPENING_PREFIX_STEP_TYPES} — i.e. the index of the first step Sol's opening did NOT cover.
 * Exported for the unit test.
 */
export function computeResumeStep(stepTypes: string[]): number {
  let i = 0;
  while (i < stepTypes.length && OPENING_PREFIX_STEP_TYPES.has(stepTypes[i])) i++;
  return i;
}

/**
 * Reply-gated arm of Sol's chosen playbook. Silent (armPlaybook sends nothing); the playbook's
 * first message fires only when the customer next replies. Never throws for a lookup miss — returns
 * an un-armed result the caller logs.
 */
export async function armSolPlaybookReplyGated(
  admin: Admin,
  args: ArmPlaybookArgs,
): Promise<ArmPlaybookResult> {
  const { workspaceId, ticketId, playbookSlug } = args;

  const { data: playbook } = await admin
    .from("playbooks")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", playbookSlug)
    .eq("is_active", true)
    .maybeSingle();
  if (!playbook) {
    return { armed: false, playbookId: null, resumeStep: null, reason: "playbook_not_found" };
  }
  const playbookId = (playbook as { id: string }).id;

  // Don't re-arm a ticket that's already mid-playbook (a concurrent follow-up turn owns it).
  const { data: ticketRow } = await admin
    .from("tickets")
    .select("active_playbook_id, customer_id")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const activePbId = (ticketRow as { active_playbook_id: string | null } | null)?.active_playbook_id ?? null;
  if (activePbId) {
    return { armed: false, playbookId, resumeStep: null, reason: "already_active" };
  }
  const customerId = (ticketRow as { customer_id: string | null } | null)?.customer_id ?? null;

  const { data: steps } = await admin
    .from("playbook_steps")
    .select("step_order, type")
    .eq("playbook_id", playbookId)
    .order("step_order", { ascending: true });
  if (!steps?.length) {
    return { armed: false, playbookId, resumeStep: null, reason: "no_steps" };
  }

  const resumeStep = computeResumeStep((steps as Array<{ type: string }>).map((s) => s.type));
  if (resumeStep >= steps.length) {
    // Every step is part of the opening prefix — Sol's reply completed the playbook's arc; nothing
    // for the executor to drive on the next reply. Leave it un-armed (the close still fires).
    return { armed: false, playbookId, resumeStep, reason: "no_post_opening_step" };
  }

  // Seed context: Sol's seed_context wins; fall back to the disputed (most-recent) order + its
  // subscription so the resumed offer/return steps have the identify context the skipped steps
  // would have populated. `playbook_intro_sent: true` — Sol's opening was the intro; the executor
  // must not re-wrap its next message as a fresh greeting.
  const seed: Record<string, unknown> = {
    ...(args.seedContext && typeof args.seedContext === "object" ? args.seedContext : {}),
    playbook_intro_sent: true,
  };
  if (customerId && !("identified_order_id" in seed)) {
    const { data: order } = await admin
      .from("orders")
      .select("id, order_number, subscription_id")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (order) {
      const o = order as { id: string; order_number: string | null; subscription_id: string | null };
      seed.identified_order_id = o.id;
      if (o.order_number && !("identified_orders" in seed)) seed.identified_orders = [o.order_number];
      if (o.subscription_id && !("identified_subscription" in seed)) seed.identified_subscription = o.subscription_id;
    }
  }

  await armPlaybook(admin, ticketId, { playbookId, step: resumeStep, context: seed });
  return { armed: true, playbookId, resumeStep, reason: "armed" };
}
