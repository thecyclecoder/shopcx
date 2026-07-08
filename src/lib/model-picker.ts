/**
 * Picks the orchestrator model (Sonnet vs Opus) per ticket. Broad Opus
 * triggers — at our ticket volume even all-Opus is ~$420/mo, well below
 * the cost of a part-time CSR. The aim is reliability, not penny-pinching:
 * Sonnet is reserved for the obviously-trivial first touch.
 *
 * Signals (any one trips Opus):
 *   • ai_turn_count >= 1 — turn 1 didn't close the ticket
 *   • Complex tags: crisis*, pb:*, j:cancel*, wb, dunning:active, fraud
 *   • Active crisis enrollment for this customer
 *   • Linked accounts (customer_links row exists for this customer)
 *   • Customer has 2+ active subscriptions
 *   • Recently merged into this ticket (sibling row with merged_into=tid in last 24h)
 *
 * LTV alone no longer trips Opus — Phase 1 of
 * docs/brain/specs/model-picker-routes-on-state-not-tags-ltv-stops-buying-opus.md.
 * The 142-ticket blind replay found 78% of Opus tickets downgrade-safe within 1
 * grade pt; crisis-enrollment + linked-accounts (not LTV) were the axes that
 * correlated with the genuinely-hard buckets. A high-value first-touch trivial
 * ticket now runs on Sonnet.
 *
 * Returns { model, reason } so we can stamp `purpose` on ai_token_usage
 * with WHY Opus was chosen — that's how we audit "did Opus actually help?"
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { TicketDirection } from "@/lib/ticket-directions";

export type OrchestratorModel = "sonnet" | "opus" | "haiku";

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
 * Order of precedence:
 *   1. Any existing Opus signal (turn>=1, complex tag, crisis, linked accounts, active
 *      subs, recent merge) → Opus. The Direction-driven Haiku route does NOT override
 *      Opus — a genuinely-hard ticket still pays for reliability.
 *   2. No Opus signals BUT a fresh + high-confidence + stateless Direction → Haiku.
 *   3. Otherwise → Sonnet (default).
 */
export function pickModelFromSignals(signals: ModelSignals): ModelPick {
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

  if (reasons.length > 0) return { model: "opus", reason: reasons.join("+") };

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
}): Promise<ModelPick> {
  const { workspaceId, ticketId, customerId } = params;
  const admin = createAdminClient();

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
    direction,
    latestConfidence,
    problemLockinThreshold,
    solHaikuFreshnessHours,
  });
}
