/**
 * Picks the orchestrator model per ticket. **Founder directive (2026-07-10): the orchestrator NEVER
 * runs on Opus.** The tiers are SONNET (the workhorse) and HAIKU (the cheap fast-path for a fresh,
 * high-confidence, stateless Sol Direction). A ticket that trips a "hard" signal used to buy Opus;
 * now it stays on Sonnet (Sonnet 5 is more than capable), and a ticket that genuinely needs deeper
 * handling is re-sessioned to SOL (the box first-touch/re-session router) rather than an Opus middle
 * tier. See [[checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
 *
 * "Hard" signals (each still computed + surfaced in `reason` as `hard:<signals>` for audit + to feed
 * the Sonnet→Sol escalation decision — but they no longer change the MODEL, only the reason):
 *   • ai_turn_count >= 1 — turn 1 didn't close the ticket
 *   • Complex tags: crisis*, pb:*, j:cancel*, wb, dunning:active, fraud
 *   • Active crisis enrollment for this customer
 *   • Linked accounts (customer_links row exists for this customer)
 *   • Customer has 2+ active subscriptions
 *   • Recently merged into this ticket (sibling row with merged_into=tid in last 24h)
 *
 * Returns { model, reason } so we can stamp `purpose` on ai_token_usage with the routing rationale.
 */
import { classifyCheckoutStuck } from "@/lib/checkout-stuck-intent";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TicketDirection } from "@/lib/ticket-directions";

export type OrchestratorModel = "sonnet" | "haiku";

export interface ModelPick {
  model: OrchestratorModel;
  reason: string;
}

export interface ModelSignals {
  aiTurnCount: number;
  tags: string[];
  crisisCount: number;
  linksCount: number;
  activeSubsCount: number;
  recentMergesCount: number;

  // Phase 2 of [[checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
  // True when the latest inbound customer message is CHECKOUT-STUCK (per
  // [[checkout-stuck-intent]] `classifyCheckoutStuck`). When true, the picker MUST NOT let
  // any future rule escalate away from Sonnet — a checkout question is not a Sonnet→Opus
  // problem, it is a re-session-Sol problem. Earliest gate in `pickModelFromSignals`; it
  // short-circuits BEFORE the hard-signal ladder so recentMergesCount>0 (Latrina's aa0b6697
  // case) can no longer drift the reason string away from `checkout-stuck`. The re-session
  // half of Phase 2 lives in [[inflection-detector]].
  isCheckoutStuck?: boolean;

  // Phase 3 (M2 sol-cheap-execution-over-ticket-direction): the Direction-driven Haiku
  // route. When every leg of the predicate is true — a fresh, high-confidence, stateless
  // Direction — the picker returns the Haiku tier INSTEAD of the sonnet default. Any leg
  // false → picker falls through to the existing Sonnet-vs-Opus rules unchanged, so
  // these signals can ONLY relax the picker toward Haiku (never push it toward Opus).
  //
  //   - direction: the live ticket_directions row (superseded_at IS NULL); null when none
  //   - latestConfidence: latest ticket_resolution_events.confidence for the ticket
  //   - problemLockinThreshold: ai_channel_config.problem_lockin_threshold (per-channel)
  //   - solHaikuFreshnessHours: ai_channel_config.sol_haiku_freshness_hours (per-channel).
  //     null → freshness window disabled (route off); non-positive → same.
  //   - nowMs: overrideable clock for tests; falls back to Date.now() inside the fn.
  direction?: TicketDirection | null;
  latestConfidence?: number | null;
  problemLockinThreshold?: number | null;
  solHaikuFreshnessHours?: number | null;
  nowMs?: number;
}

const COMPLEX_TAG_PREFIXES = ["crisis", "pb:", "j:cancel", "fraud"];
const COMPLEX_TAGS_EXACT = ["wb", "dunning:active"];

/**
 * Pure decision core: given the collected signals, decide the model + why.
 * Kept separate from `pickOrchestratorModel` so the routing rule is unit-
 * testable without touching the DB.
 *
 * Order of precedence (never Opus — see the file header):
 *   1. Any "hard" signal (turn>=1, complex tag, crisis, linked accounts, active subs, recent
 *      merge) → SONNET with reason `hard:<signals>`. (Was Opus; the hard signals now only shape
 *      the reason, not the model. The Haiku fast-path is deliberately NOT taken on a hard ticket.)
 *   2. No hard signals BUT a fresh + high-confidence + stateless Direction → Haiku.
 *   3. Otherwise → Sonnet (default).
 */
export function pickModelFromSignals(signals: ModelSignals): ModelPick {
  // Phase 2 of [[checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
  // A CHECKOUT-STUCK message always stays on Sonnet — earliest gate so no future rule (a
  // reintroduced Opus tier, a new "hard" signal, the Haiku fast-path) can escalate or
  // relax away from it. The re-session router ([[inflection-detector]]) also fires; the
  // model tweak is the belt while Sol takes over. Reason string is verbatim
  // `checkout-stuck` so ai_token_usage.purpose surfaces the audit slice cleanly.
  if (signals.isCheckoutStuck) return { model: "sonnet", reason: "checkout-stuck" };

  const reasons: string[] = [];

  if (signals.aiTurnCount >= 1) reasons.push(`turn>=${signals.aiTurnCount}`);

  const hitTag = signals.tags.find(
    t =>
      COMPLEX_TAG_PREFIXES.some(p => t.startsWith(p)) ||
      COMPLEX_TAGS_EXACT.includes(t),
  );
  if (hitTag) reasons.push(`tag=${hitTag}`);

  if (signals.crisisCount > 0) reasons.push("crisis-enrollment");
  if (signals.linksCount > 0) reasons.push("linked-accounts");
  if (signals.activeSubsCount >= 2) reasons.push(`active-subs=${signals.activeSubsCount}`);
  if (signals.recentMergesCount > 0) reasons.push("recently-merged");

  // Founder directive (2026-07-10): NEVER route the orchestrator to Opus. A ticket that trips a
  // hard signal (turn>=1, complex tag, crisis, linked accounts, 2+ subs, recent merge) stays on
  // SONNET — Sonnet 5 is more than capable, and when a ticket genuinely needs deeper handling the
  // path is to re-session SOL (the box first-touch/re-session router), not an Opus middle tier. The
  // reason string is still returned so we can audit which tickets tripped the hard signals and feed
  // the Sonnet→Sol escalation decision. See [[checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
  if (reasons.length > 0) return { model: "sonnet", reason: `hard:${reasons.join("+")}` };

  const haiku = pickHaikuFromDirection(signals);
  if (haiku) return haiku;

  return { model: "sonnet", reason: "default" };
}

/**
 * Evaluate the Direction-driven Haiku predicate. Returns a Haiku ModelPick when every
 * leg is true, null otherwise. Extracted so the predicate has one call site (the picker)
 * and one unit-test target; the spec's four verification bullets each map to one leg here.
 */
function pickHaikuFromDirection(signals: ModelSignals): ModelPick | null {
  const dir = signals.direction ?? null;
  if (!dir) return null;
  if (dir.superseded_at) return null;
  if (dir.chosen_path !== "stateless") return null;

  const conf = signals.latestConfidence;
  const threshold = signals.problemLockinThreshold;
  if (typeof conf !== "number" || typeof threshold !== "number") return null;
  if (conf < threshold) return null;

  const freshHours = signals.solHaikuFreshnessHours;
  if (typeof freshHours !== "number" || !(freshHours > 0)) return null;

  const authoredAtMs = new Date(dir.authored_at).getTime();
  if (!Number.isFinite(authoredAtMs)) return null;
  const nowMs = signals.nowMs ?? Date.now();
  const ageMs = nowMs - authoredAtMs;
  const freshMs = freshHours * 3600 * 1000;
  if (!(ageMs < freshMs)) return null;

  const ageHours = ageMs / 3600000;
  return {
    model: "haiku",
    reason: `sol-direction-fresh(conf=${conf.toFixed(2)},thr=${threshold.toFixed(2)},age_h=${ageHours.toFixed(1)},window_h=${freshHours})`,
  };
}

export async function pickOrchestratorModel(params: {
  workspaceId: string;
  ticketId: string;
  customerId: string | null;
  // Phase 3 (M2): the caller may pass a pre-loaded live Direction so the picker doesn't
  // double-fetch what unified-ticket-handler's Step 2e has already loaded for
  // assembleDirectionContext. undefined → picker loads it itself; null → picker treats
  // the ticket as directionless (skips both the fetch and the Haiku route).
  direction?: TicketDirection | null;
  // Phase 2 of [[checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
  // The Inngest pipeline already has the newest inbound customer message text in `msg`; passing
  // it in lets the picker classify checkout-stuck without a second DB read. undefined → picker
  // skips the classifier (isCheckoutStuck falls back to `false`); null/"" → same.
  newestMessage?: string | null;
}): Promise<ModelPick> {
  const { workspaceId, ticketId, customerId } = params;
  const admin = createAdminClient();
  const isCheckoutStuck = classifyCheckoutStuck(params.newestMessage ?? null).matched;

  const { data: ticket } = await admin
    .from("tickets")
    .select("ai_turn_count, tags, channel")
    .eq("id", ticketId)
    .maybeSingle();

  const aiTurnCount = ticket?.ai_turn_count || 0;
  const tags: string[] = (ticket?.tags as string[]) || [];

  let crisisCount = 0;
  let linksCount = 0;
  let activeSubsCount = 0;
  let recentMergesCount = 0;

  if (customerId) {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [crisis, links, subs, merges] = await Promise.all([
      admin
        .from("crisis_customer_actions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId)
        .is("tier3_response", null)
        .is("paused_at", null)
        .is("removed_item_at", null)
        .eq("cancelled", false),
      admin
        .from("customer_links")
        .select("group_id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId),
      admin
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId)
        .eq("status", "active"),
      admin
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("merged_into", ticketId)
        .gte("updated_at", since24h),
    ]);

    crisisCount = crisis.count || 0;
    linksCount = links.count || 0;
    activeSubsCount = subs.count || 0;
    recentMergesCount = merges.count || 0;
  }

  // Direction-driven Haiku signals (Phase 3 of M2). Only fetch what's needed —
  // and only when the caller hasn't already handed us a Direction.
  let direction: TicketDirection | null = params.direction ?? null;
  const directionExplicitlyPassed = Object.prototype.hasOwnProperty.call(params, "direction");
  if (!directionExplicitlyPassed) {
    const { loadLiveDirection } = await import("@/lib/ticket-directions");
    direction = await loadLiveDirection(admin, ticketId, { workspace_id: workspaceId });
  }

  // Only fetch confidence + channel config when we actually have a candidate Direction —
  // the DB reads are wasted otherwise (no direction ⇒ Haiku predicate can't fire).
  let latestConfidence: number | null = null;
  let problemLockinThreshold: number | null = null;
  let solHaikuFreshnessHours: number | null = null;
  if (direction && !direction.superseded_at) {
    const channel: string = (ticket?.channel as string) || "email";
    const [{ data: cfg }, { data: latestEvent }] = await Promise.all([
      admin
        .from("ai_channel_config")
        .select("problem_lockin_threshold, sol_haiku_freshness_hours")
        .eq("workspace_id", workspaceId)
        .eq("channel", channel)
        .maybeSingle(),
      admin
        .from("ticket_resolution_events")
        .select("confidence")
        .eq("workspace_id", workspaceId)
        .eq("ticket_id", ticketId)
        .not("confidence", "is", null)
        .order("turn_index", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (typeof cfg?.problem_lockin_threshold === "number") problemLockinThreshold = cfg.problem_lockin_threshold;
    if (typeof cfg?.sol_haiku_freshness_hours === "number") solHaikuFreshnessHours = cfg.sol_haiku_freshness_hours;
    if (typeof latestEvent?.confidence === "number") latestConfidence = latestEvent.confidence;
  }

  return pickModelFromSignals({
    aiTurnCount,
    tags,
    crisisCount,
    linksCount,
    activeSubsCount,
    recentMergesCount,
    isCheckoutStuck,
    direction,
    latestConfidence,
    problemLockinThreshold,
    solHaikuFreshnessHours,
  });
}
