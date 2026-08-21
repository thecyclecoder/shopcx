/**
 * Subscription overcharge detection + remediation plan.
 *
 * A subscription renewal can charge a customer *above* the rate they were
 * grandfathered/established at — two shapes:
 *
 *   1. Prior steady-state renewal — the latest renewal's per-unit realized
 *      price is materially above the rate the customer was reliably paying on
 *      earlier renewals (a silent price creep).
 *   2. Dropped grandfathered base — the sub's effective per-unit is now ≥ MSRP
 *      (no discount applied / pricing policy collapsed) while order history
 *      shows a *lower* locked rate. This is the `pricingPolicy: null` landmine
 *      [[appstle-pricing]] heals: the base was dropped and the customer is
 *      paying full retail on a sub that used to be discounted.
 *
 * `detectOverchargesForCustomer` is read-only and surfaced into BOTH the
 * orchestrator account context ([[sonnet-orchestrator-v2]]) and the escalation
 * triage brief ([[box-escalation-triage]]) so neither path reaches for
 * create_return / cancel before checking whether the real fix is a refund +
 * a pricing heal.
 *
 * The detector emits the {charged, expected, delta, dropped_base} signal plus,
 * per overcharged line, the grandfathered base to restore. It NEVER moves money
 * or mutates a sub — `buildOverchargePlan` returns the deterministic action
 * sequence (partial_refund → update_line_item_price → reply) that the existing
 * gated/logged executors run. Restoring the base goes through the Appstle
 * pricing-policy heal (update_line_item_price → subUpdateLineItemPrice →
 * healOnTouch) for Appstle subs and price_override_cents for internal subs —
 * NEVER migrate-to-internal (that needs a saved Braintree PM and is not the fix
 * for a pricing error).
 *
 * Money-safety guardrail: the established baseline is clamped to the active
 * 50%-MSRP floor — we never propose restoring a customer below the floor the
 * pricing cleanup raised everyone to ([[tables/policies]] subscription-pricing).
 *
 * Sustained-rate baseline: the "established" rate is a sustained demonstrated
 * rate — either held across ≥N consecutive recent renewals, or the mode of
 * post-swap history with ≥N total occurrences — NEVER a single `Math.min` over
 * one-off promo/introductory orders. Pre-swap-reset history is excluded (a
 * variant swap resets the price lock, per [[subscriptions]] price-lock-scope):
 * walking prior orders back, the first order that did not carry this variant
 * marks the swap-away boundary and truncates the history. When no sustained
 * rate exists, the detector abstains on that line. Ticket
 * b99f495e-7717-4553-a1bd-d095bb082094 is the ground-truth case (two disparate
 * promo renewals + swap-away-and-back → old code auto-proposed an improper
 * refund + a permanent below-floor restore; hardened detector abstains).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveLineSnsPct } from "@/lib/appstle-pricing";

type Admin = ReturnType<typeof createAdminClient>;

/** $1 and 2% — below this a per-unit difference is rounding/tax noise, not an overcharge. */
const MATERIAL_OVERCHARGE_CENTS = 100;
const MATERIAL_OVERCHARGE_PCT = 0.02;

/**
 * Minimum support for a rate to count as "sustained" — either held across this
 * many CONSECUTIVE recent renewals, or the mode of post-swap history with at
 * least this many occurrences. A single Math.min over one-off promo orders is
 * not a locked rate; the CEO 2026-08-01 ruling honors a demonstrated rate only
 * over a sustained window. Ticket b99f495e-7717-4553-a1bd-d095bb082094 is the
 * ground-truth case (two disparate promo renewals at $26.96 + $35.95 → no
 * sustained baseline → no false overcharge).
 */
export const SUSTAINED_BASELINE_MIN_SUPPORT = 3;

export interface OverchargeLine {
  variant_id: string;
  title: string;
  quantity: number;
  /** cents — per-unit price the overcharging renewal actually charged. */
  charged_per_unit: number;
  /** cents — per-unit grandfathered/established baseline (floor-clamped). */
  expected_per_unit: number;
  /**
   * cents — pre-discount base to lock so the realized price returns to
   * expected_per_unit going forward. Pass to update_line_item_price /
   * subUpdateLineItemPrice (Appstle) or it becomes price_override_cents
   * (internal). base = expected / (1 − sns%).
   */
  restore_base_cents: number;
}

export interface OverchargeSignal {
  detected: true;
  subscription_id: string;
  shopify_contract_id: string | null;
  is_internal: boolean;
  /** The renewal order that overcharged. */
  order_id: string;
  shopify_order_id: string | null;
  order_number: string | null;
  financial_status: string | null;
  /** cents — what the overcharged line(s) actually charged on this renewal (per-unit × qty, summed). */
  charged: number;
  /** cents — the established/grandfathered baseline for the same line(s). */
  expected: number;
  /** cents — charged − expected; the refundable overcharge AND the partial_refund amount. */
  delta: number;
  /** true when a grandfathered base was dropped (effective per-unit ≥ MSRP while history shows a lower locked rate). */
  dropped_base: boolean;
  /** Per overcharged line — variant + the grandfathered base to restore. */
  lines: OverchargeLine[];
  reason: string;
}

interface OrderRow {
  id: string;
  shopify_order_id: string | null;
  order_number: string | null;
  financial_status: string | null;
  source_name: string | null;
  created_at: string;
  subscription_id: string | null;
  line_items: Array<{ title?: string; variant_id?: string | number; quantity?: number; price_cents?: number }> | null;
}

interface SubRow {
  id: string;
  shopify_contract_id: string | null;
  status: string;
  is_internal: boolean | null;
  items: Array<{ title?: string; variant_id?: string | number }> | null;
}

interface VariantCatalog {
  productId: string | null;
  msrpCents: number;
}

/**
 * Detect overcharges across a customer's active/paused subscriptions.
 * Read-only. Returns one signal per overcharged subscription (empty when none).
 */
export async function detectOverchargesForCustomer(
  workspaceId: string,
  customerId: string,
): Promise<OverchargeSignal[]> {
  const admin = createAdminClient();

  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, is_internal, items")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .in("status", ["active", "paused"]);
  if (!subs?.length) return [];

  const subIds = subs.map((s) => s.id as string);
  // Pull renewal orders by subscription_id (not customer_id) so a renewal that
  // landed on a linked profile still counts toward the baseline.
  const { data: orders } = await admin
    .from("orders")
    .select("id, shopify_order_id, order_number, financial_status, source_name, created_at, subscription_id, line_items")
    .eq("workspace_id", workspaceId)
    .in("subscription_id", subIds)
    .order("created_at", { ascending: false });

  const catalog = await loadVariantCatalog(admin, workspaceId, [
    ...(subs as SubRow[]).flatMap((s) => (s.items || []).map((i) => String(i.variant_id || ""))),
    ...((orders as OrderRow[] | null) || []).flatMap((o) => (o.line_items || []).map((i) => String(i.variant_id || ""))),
  ]);

  const signals: OverchargeSignal[] = [];
  for (const sub of subs as SubRow[]) {
    const subOrders = ((orders as OrderRow[] | null) || []).filter(
      (o) => o.subscription_id === sub.id && o.source_name !== "shopify_draft_order",
    );
    const signal = await detectForSubscription(admin, workspaceId, sub, subOrders, catalog);
    if (signal) signals.push(signal);
  }
  return signals;
}

/** Detect an overcharge on a single subscription by id. Read-only. */
export async function detectOvercharge(
  workspaceId: string,
  subscriptionId: string,
): Promise<OverchargeSignal | null> {
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, is_internal, items")
    .eq("workspace_id", workspaceId)
    .eq("id", subscriptionId)
    .maybeSingle();
  if (!sub) return null;
  const { data: orders } = await admin
    .from("orders")
    .select("id, shopify_order_id, order_number, financial_status, source_name, created_at, subscription_id, line_items")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", subscriptionId)
    .neq("source_name", "shopify_draft_order")
    .order("created_at", { ascending: false });
  const catalog = await loadVariantCatalog(admin, workspaceId, [
    ...((sub.items as SubRow["items"]) || []).map((i) => String(i.variant_id || "")),
    ...((orders as OrderRow[] | null) || []).flatMap((o) => (o.line_items || []).map((i) => String(i.variant_id || ""))),
  ]);
  return detectForSubscription(admin, workspaceId, sub as SubRow, (orders as OrderRow[]) || [], catalog);
}

/**
 * Post-swap variant history. Given `prior` orders sorted newest→oldest, walk
 * back and collect this variant's per-unit prices UNTIL an order is reached
 * that did not carry the variant — that's the swap-away boundary and anything
 * older is stale. A per-line variant-swap on an Appstle/internal subscription
 * resets the price lock to current pricing ([[subscriptions]] price-lock-
 * scope), so pre-boundary rates cannot be treated as still-locked. A prior
 * order that carries the variant but with a missing/zero `price_cents` is
 * counted as still on-variant (does not cross the boundary) but contributes
 * no rate. Exported for unit tests.
 */
export function postSwapVariantHistory(
  prior: Array<{
    line_items:
      | Array<{ variant_id?: string | number; price_cents?: number }>
      | null;
  }>,
  variantId: string,
): number[] {
  const out: number[] = [];
  for (const o of prior) {
    const match = (o.line_items || []).find(
      (li) => String(li.variant_id || "") === variantId,
    );
    if (!match) break; // swap-away boundary
    if (match.price_cents) out.push(match.price_cents);
  }
  return out;
}

/**
 * Sustained-baseline resolver. Given a variant's per-unit history (newest→
 * oldest, post-swap-reset), return the RELIABLE rate — either the rate held
 * across ≥`minSupport` consecutive most-recent renewals, or the mode with
 * ≥`minSupport` total occurrences (tie-broken by the lowest rate — a customer
 * who paid two rates equally often is grandfathered at the cheaper one). Returns
 * null when no rate meets the threshold, in which case the detector must
 * abstain: a single Math.min over unstable/promo history is not a locked rate.
 * Exported so unit tests can pin the predicate without a live DB.
 */
export function sustainedBaseline(
  history: number[],
  minSupport: number = SUSTAINED_BASELINE_MIN_SUPPORT,
): number | null {
  if (history.length < minSupport) return null;
  // Run of consecutive same-rate entries at the head (most recent).
  const head = history[0];
  let run = 1;
  for (let i = 1; i < history.length; i++) {
    if (history[i] === head) run++;
    else break;
  }
  if (run >= minSupport) return head;
  // Mode with support ≥ minSupport, tie-broken by the lowest rate.
  const counts = new Map<number, number>();
  for (const p of history) counts.set(p, (counts.get(p) || 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [rate, count] of counts) {
    if (count < minSupport) continue;
    if (count > bestCount || (count === bestCount && best != null && rate < best)) {
      best = rate;
      bestCount = count;
    }
  }
  return best;
}

async function loadVariantCatalog(
  admin: Admin,
  workspaceId: string,
  variantIds: string[],
): Promise<Map<string, VariantCatalog>> {
  const ids = [...new Set(variantIds.filter(Boolean))];
  const map = new Map<string, VariantCatalog>();
  if (!ids.length) return map;
  const { data: variants } = await admin
    .from("product_variants")
    .select("shopify_variant_id, product_id, price_cents")
    .eq("workspace_id", workspaceId)
    .in("shopify_variant_id", ids);
  for (const v of variants || []) {
    map.set(String(v.shopify_variant_id), {
      productId: (v.product_id as string) || null,
      msrpCents: (v.price_cents as number) || 0,
    });
  }
  return map;
}

async function detectForSubscription(
  admin: Admin,
  workspaceId: string,
  sub: SubRow,
  subOrders: OrderRow[],
  catalog: Map<string, VariantCatalog>,
): Promise<OverchargeSignal | null> {
  // Need a current renewal + at least one prior renewal to establish a baseline.
  if (subOrders.length < 2) return null;
  const current = subOrders[0]; // most recent renewal (subOrders is desc by date)
  // A fully-refunded order has nothing left to remediate.
  if (current.financial_status === "refunded") return null;
  const prior = subOrders.slice(1);

  const lines: OverchargeLine[] = [];
  let dropped = false;

  for (const item of current.line_items || []) {
    const variantId = String(item.variant_id || "");
    if (!variantId) continue;
    const currentPerUnit = item.price_cents || 0;
    const qty = item.quantity || 1;
    if (currentPerUnit <= 0) continue;

    // Historical per-unit prices for this variant across prior renewals, sorted
    // newest→oldest and TRUNCATED at the most recent variant-swap boundary. A
    // variant swap resets the price lock ([[subscriptions]] price-lock-scope),
    // so pre-swap history is stale — walking back, the first prior order that
    // did NOT carry this variant marks the swap-away point; anything older is
    // dropped from the baseline computation.
    const history = postSwapVariantHistory(prior, variantId);
    if (!history.length) continue;

    const cat = catalog.get(variantId);
    const msrp = cat?.msrpCents || 0;
    const floor = msrp > 0 ? Math.round(msrp * 0.5) : 0;
    const standard = msrp > 0 ? Math.round(msrp * 0.75) : 0;

    // The rate the customer was RELIABLY paying — a sustained locked rate
    // (mode with ≥N support, or ≥N consecutive renewals at the same rate) over
    // the post-swap history. A single Math.min over one-off promo orders is
    // NOT a locked rate: ticket b99f495e (two disparate promo renewals at
    // $26.96 + $35.95 rising with quantity) is the ground-truth case where a
    // Math.min baseline auto-proposed an improper refund + a permanent
    // below-floor price restore. When no sustained rate exists we skip
    // detection on this line (no baseline → no signal). Clamp UP to the 50%
    // floor: history below the floor was raised by the pricing cleanup and
    // can no longer be re-offered (active policy).
    const baselinePerUnit = sustainedBaseline(history, SUSTAINED_BASELINE_MIN_SUPPORT);
    if (baselinePerUnit == null) continue;
    const expectedPerUnit = msrp > 0 ? Math.max(baselinePerUnit, floor) : baselinePerUnit;

    // Shape 1: current per-unit materially above the established baseline.
    const overByHistory =
      currentPerUnit - expectedPerUnit >= MATERIAL_OVERCHARGE_CENTS &&
      currentPerUnit >= expectedPerUnit * (1 + MATERIAL_OVERCHARGE_PCT);

    // Shape 2: effective per-unit ≥ MSRP while history shows a lower locked rate.
    const droppedBase = msrp > 0 && currentPerUnit >= msrp && baselinePerUnit < standard;

    if (!overByHistory && !droppedBase) continue;
    if (currentPerUnit <= expectedPerUnit) continue; // floor-clamp ate the delta — nothing to refund

    const snsPct = await resolveLineSnsPct(admin, workspaceId, cat?.productId);
    const factor = 1 - snsPct / 100;
    const restoreBaseCents = factor > 0 ? Math.round(expectedPerUnit / factor) : expectedPerUnit;

    if (droppedBase) dropped = true;
    lines.push({
      variant_id: variantId,
      title: item.title || "item",
      quantity: qty,
      charged_per_unit: currentPerUnit,
      expected_per_unit: expectedPerUnit,
      restore_base_cents: restoreBaseCents,
    });
  }

  if (!lines.length) return null;

  const charged = lines.reduce((s, l) => s + l.charged_per_unit * l.quantity, 0);
  const expected = lines.reduce((s, l) => s + l.expected_per_unit * l.quantity, 0);
  const delta = charged - expected;
  if (delta < MATERIAL_OVERCHARGE_CENTS) return null;

  const reason = dropped
    ? `Grandfathered base dropped on renewal #${current.order_number} — charged at/above MSRP vs locked rate`
    : `Renewal #${current.order_number} charged above the customer's established rate`;

  return {
    detected: true,
    subscription_id: sub.id,
    shopify_contract_id: sub.shopify_contract_id,
    is_internal: !!sub.is_internal,
    order_id: current.id,
    shopify_order_id: current.shopify_order_id,
    order_number: current.order_number,
    financial_status: current.financial_status,
    charged,
    expected,
    delta,
    dropped_base: dropped,
    lines,
    reason,
  };
}

export interface OverchargePlan {
  /** partial_refund(charged − expected) on the overcharging order. */
  refund: { type: "partial_refund"; shopify_order_id: string; amount_cents: number; reason: string } | null;
  /** Restore the grandfathered base going forward (Appstle heal or internal price_override_cents). */
  restore: Array<{ type: "update_line_item_price"; contract_id: string; variant_id: string; base_price_cents: number }>;
  /** Talking points for the customer_reply (we caught it, refunded, fixed the sub, no cancel needed). */
  reply_points: string[];
}

/**
 * The deterministic remediation playbook for an overcharge signal. Returns the
 * action sequence — the orchestrator / triage solver run these through the
 * existing gated, logged executors (partial_refund, update_line_item_price).
 * NEVER emits migrate-to-internal: a pricing error is healed in place.
 */
export function buildOverchargePlan(signal: OverchargeSignal): OverchargePlan {
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const refund =
    signal.delta >= MATERIAL_OVERCHARGE_CENTS && signal.shopify_order_id
      ? {
          type: "partial_refund" as const,
          shopify_order_id: signal.shopify_order_id,
          amount_cents: signal.delta,
          reason: `Subscription overcharge remediation — renewal #${signal.order_number} charged ${dollars(
            signal.charged,
          )} vs established ${dollars(signal.expected)} (delta ${dollars(signal.delta)})`,
        }
      : null;

  const restore = signal.shopify_contract_id
    ? signal.lines.map((l) => ({
        type: "update_line_item_price" as const,
        contract_id: signal.shopify_contract_id as string,
        variant_id: l.variant_id,
        base_price_cents: l.restore_base_cents,
      }))
    : [];

  return {
    refund,
    restore,
    reply_points: [
      "Caught a pricing error on the most recent renewal — it charged above the rate they were on.",
      `Refunded the difference (${dollars(signal.delta)}) to their original payment method.`,
      "Fixed the subscription so future renewals bill at the correct rate.",
      "No need to cancel — it's already sorted.",
    ],
  };
}

// ────────────────────────────────────────────────────────────────────
// Sanctioned-source rule for a `update_line_item_price` write.
//
// The agent may TRIGGER a price correction, but may not INVENT the number.
// When an overcharge signal names the target variant, the signal's
// `restore_base_cents` is authoritative and the agent's proposed base is
// only logged when it materially diverges. When no signal names the
// variant, the handler guards the invariant "never write a base whose
// realized per-unit exceeds the customer's established rate" with the
// same `>= $1 AND >= 2%` materiality floor `detectForSubscription` uses at
// detection. Extracted from `update_line_item_price` in [[action-executor]]
// so it can be tested purely (no admin, no DB) — the projector callback
// wraps `resolveSubscriptionPricing` in the runtime and returns a fixture
// value in the unit tests. Spec:
// docs/brain/specs/a-price-correction-must-use-the-computed-rate-not-an-agents-arithmetic.
// ────────────────────────────────────────────────────────────────────

export type RestoreBaseSource = "signal" | "agent";
export type RestoreBaseRefuseReason =
  | "raise_no_signal"
  | "immaterial"
  | "exceeds_established";

export type RestoreBaseDecisionOk = {
  ok: true;
  /** The cents value to write via `subUpdateLineItemPrice`. */
  base: number;
  /** Suffix to append to the action summary — visible in the ticket thread. */
  note: string;
  /** Where the number came from — the audit event stamps this. */
  source: RestoreBaseSource;
  signalRestoreBaseCents: number | null;
  agentBaseCents: number;
  previousRealizedPerUnitCents: number | null;
  projectedRealizedPerUnitCents: number | null;
};

export type RestoreBaseDecisionRefused = {
  ok: false;
  error: string;
  refuseReason: RestoreBaseRefuseReason;
  agentBaseCents: number;
  previousRealizedPerUnitCents: number | null;
  projectedRealizedPerUnitCents: number | null;
};

export type RestoreBaseDecision =
  | RestoreBaseDecisionOk
  | RestoreBaseDecisionRefused;

export interface DeriveRestoreBaseInput {
  signal: OverchargeSignal | null;
  contractId: string;
  variantId: string;
  agentBaseCents: number;
  /**
   * Callback that returns the customer's realized per-unit for the target
   * variant. Pass `null` to get the CURRENT realized (unchanged items),
   * pass a proposed base to get what would be realized AFTER the write.
   * Runtime wraps `resolveSubscriptionPricing`; tests pass a fixture.
   */
  project: (proposedBaseCents: number | null) => Promise<number | null>;
}

export async function deriveRestoreBase(
  input: DeriveRestoreBaseInput,
): Promise<RestoreBaseDecision> {
  const { signal, contractId, variantId, agentBaseCents, project } = input;
  const previousRealizedPerUnitCents = await project(null);

  const line = signal?.lines.find((l) => String(l.variant_id) === String(variantId));

  // ── Signal path — computed rate wins; agent's disagreement is only logged.
  if (line) {
    const signalBase = line.restore_base_cents;
    let note = "";
    if (Math.abs(signalBase - agentBaseCents) > 100) {
      note = ` (agent-proposed $${(agentBaseCents / 100).toFixed(2)} → signal-computed $${(signalBase / 100).toFixed(2)})`;
    }
    const projected = await project(signalBase);
    // Invariant: the write must not raise the realized per-unit above the
    // established rate — the signal already respects this by construction,
    // but the internal engine can stack a quantity break on top of the base,
    // so we confirm via resolveSubscriptionPricing rather than assume.
    if (projected != null && projected > line.expected_per_unit + 1) {
      return {
        ok: false,
        error: `Refusing to write base $${(signalBase / 100).toFixed(2)} on contract ${contractId} variant ${variantId}: projected realized $${(projected / 100).toFixed(2)} exceeds established $${(line.expected_per_unit / 100).toFixed(2)}.`,
        refuseReason: "exceeds_established",
        agentBaseCents,
        previousRealizedPerUnitCents,
        projectedRealizedPerUnitCents: projected,
      };
    }
    return {
      ok: true,
      base: signalBase,
      note,
      source: "signal",
      signalRestoreBaseCents: signalBase,
      agentBaseCents,
      previousRealizedPerUnitCents,
      projectedRealizedPerUnitCents: projected,
    };
  }

  // ── No-signal path — refuse a RAISE and apply the materiality floor.
  // Lowering with no signal stays allowed — it cannot harm the customer and
  // goodwill discounts are a real use.
  const projected = await project(agentBaseCents);
  if (previousRealizedPerUnitCents != null && projected != null) {
    const absChange = Math.abs(projected - previousRealizedPerUnitCents);
    // Phase 2 materiality floor: catalog rounding drift shouldn't fire any
    // correction. Below `>= $1 AND >= 2%` the change is noise, and a
    // "we overcharged you" refund on that scale mints a wrong-narrative
    // ticket on an untouched subscription (the 2026-08-02 failure mode).
    if (absChange < 100 || absChange < previousRealizedPerUnitCents * 0.02) {
      return {
        ok: false,
        error: `Refusing immaterial price change on contract ${contractId} variant ${variantId}: change $${(absChange / 100).toFixed(2)} on a $${(previousRealizedPerUnitCents / 100).toFixed(2)} baseline is below the $1 AND 2% materiality floor (catalog rounding drift shouldn't trigger a correction).`,
        refuseReason: "immaterial",
        agentBaseCents,
        previousRealizedPerUnitCents,
        projectedRealizedPerUnitCents: projected,
      };
    }
    if (
      projected - previousRealizedPerUnitCents >= 100 &&
      projected >= previousRealizedPerUnitCents * 1.02
    ) {
      return {
        ok: false,
        error: `Refusing to raise realized price on contract ${contractId} variant ${variantId}: no overcharge signal justifies the increase from $${(previousRealizedPerUnitCents / 100).toFixed(2)} to $${(projected / 100).toFixed(2)} (agent-supplied base $${(agentBaseCents / 100).toFixed(2)}).`,
        refuseReason: "raise_no_signal",
        agentBaseCents,
        previousRealizedPerUnitCents,
        projectedRealizedPerUnitCents: projected,
      };
    }
  }
  return {
    ok: true,
    base: agentBaseCents,
    note: "",
    source: "agent",
    signalRestoreBaseCents: null,
    agentBaseCents,
    previousRealizedPerUnitCents,
    projectedRealizedPerUnitCents: projected,
  };
}

/** True when the refuse reason surfaces a RAISE attempt that should be escalated. */
export function isRaiseAttempt(reason: RestoreBaseRefuseReason): boolean {
  return reason === "raise_no_signal" || reason === "exceeds_established";
}

/** Human-readable block for the orchestrator / triage context, including the action plan. */
export function formatOverchargeForAgent(signal: OverchargeSignal): string {
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const plan = buildOverchargePlan(signal);
  const lineStr = signal.lines
    .map(
      (l) =>
        `${l.title} (variant ${l.variant_id}) x${l.quantity}: charged ${dollars(l.charged_per_unit)}/unit vs established ${dollars(
          l.expected_per_unit,
        )}/unit → restore base ${dollars(l.restore_base_cents)}`,
    )
    .join("; ");

  const out: string[] = [];
  out.push(
    `⚠️ OVERCHARGE DETECTED on sub ${signal.shopify_contract_id || signal.subscription_id} (${
      signal.is_internal ? "internal" : "Appstle"
    }): renewal #${signal.order_number} charged ${dollars(signal.charged)}, expected ${dollars(
      signal.expected,
    )}, delta ${dollars(signal.delta)}${signal.dropped_base ? ", dropped_base=true" : ""}. ${signal.reason}.`,
  );
  out.push(`  Lines: ${lineStr}`);
  out.push(
    "  REMEDIATION (do this instead of create_return / cancel): " +
      [
        plan.refund ? `partial_refund ${dollars(plan.refund.amount_cents)} on shopify_order_id ${plan.refund.shopify_order_id}` : null,
        plan.restore.length
          ? `update_line_item_price to restore the base (heals on ${signal.is_internal ? "internal price_override_cents" : "Appstle — NEVER migrate-to-internal"})`
          : null,
        "then a customer_reply: caught the pricing error, refunded the difference, fixed the sub, no cancel needed.",
      ]
        .filter(Boolean)
        .join("; "),
  );
  return out.join("\n");
}
