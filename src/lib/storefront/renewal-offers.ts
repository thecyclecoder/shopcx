/**
 * Dynamic persist-to-renewal offers — M6 of the storefront-optimizer goal
 * (docs/brain/specs/storefront-dynamic-renewal-offers.md).
 *
 * The gated, highest-stakes optimizer lever: an offer that PERSISTS TO RENEWAL (not just the
 * first order). A first-order discount stays a coupon ([[coupons]]) on the autonomous path;
 * a persist-to-renewal offer becomes a scoped, time-boxed [[pricing_rule_offers]] row that
 * bleeds margin on EVERY renewal — so it is ALWAYS owner-approved, never autonomous.
 *
 * This module owns the offer lifecycle the worker + engine call:
 *   • modelRenewalMargin / evaluateOfferMargin — the Phase 3 margin-floor hard rail. Uses the
 *     SAME flagged placeholder economics as the M3 proxy (no new hardcoded COGS). A breach is
 *     blocked + escalated, never surfaced as a normal approvable proposal.
 *   • proposeOffer — create a `proposed` (inactive) offer from the agent's typed plan, after
 *     the margin check. Returns { blocked } when below the floor.
 *   • activateOffer — on owner approval, flip proposed/approved → active (persists to renewal).
 *   • deactivateOffer / deactivateOffersForExperiment / expireDueOffers — Phase 3 expiry +
 *     rollback. The engine applies an offer ONLY while status='active', so deactivation reverts
 *     affected subs to base renewal pricing with NOTHING baked to un-bake.
 *   • resolveActiveOffer — the engine's read: the sub's bound offer iff active + in window.
 *   • bindOfferOnConversion — checkout binding: a sub that converted on the offer arm
 *     references the offer (a reference, never a price).
 *
 * Every state change writes a [[pricing_rule_offer_events]] audit row — a persist-to-renewal
 * offer touched real renewals, so its full lifecycle is supervisable (the north star).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { PLACEHOLDER_MARGIN_FRACTION } from "@/lib/storefront/ltv-proxy";

type Admin = ReturnType<typeof createAdminClient>;

export type OfferStatus = "proposed" | "approved" | "active" | "expired";
export type OfferType = "subscribe_discount_pct" | "fixed_renewal_price";
export type OfferLanderType = "pdp" | "listicle" | "beforeafter" | "advertorial";

/** Default modeled-margin floor when the policy carries none (mirrors the column default). */
export const DEFAULT_RENEWAL_MARGIN_FLOOR_PCT = 0.35;
/** Default offer window when the agent doesn't specify one (a time-boxed experiment run). */
export const DEFAULT_OFFER_WINDOW_DAYS = 60;

/** The persist-to-renewal offer row (pricing_rule_offers). */
export interface RenewalOffer {
  id: string;
  workspace_id: string;
  product_id: string;
  pricing_rule_id: string | null;
  experiment_id: string | null;
  variant_id: string | null;
  lander_type: OfferLanderType | null;
  audience: string;
  offer_type: OfferType;
  subscribe_discount_pct: number | null;
  renewal_price_cents: number | null;
  starts_at: string;
  ends_at: string;
  status: OfferStatus;
  modeled_renewal_margin_pct: number | null;
  margin_floor_pct: number | null;
  margin_floor_ok: boolean | null;
  cogs_source_missing: boolean;
}

/** The typed offer the optimizer proposes (the `offer` lever variant). */
export interface OfferPlan {
  product_id: string;
  lander_type: OfferLanderType;
  audience: string;
  offer_type: OfferType;
  /** Set when offer_type='subscribe_discount_pct' — the override S&S percent at renewal. */
  subscribe_discount_pct?: number;
  /** Set when offer_type='fixed_renewal_price' — the fixed per-unit renewal price. */
  renewal_price_cents?: number;
  /** Optional explicit window; defaults to now → now + DEFAULT_OFFER_WINDOW_DAYS. */
  starts_at?: string;
  ends_at?: string;
  hypothesis?: string;
  rationale?: string;
}

// ── Margin floor (Phase 3 hard rail) ────────────────────────────────────────────

export interface MarginModel {
  /** The effective per-unit renewal price the offer charges (cents). */
  offer_renewal_cents: number;
  /** The base (no-offer) S&S renewal price for reference (cents). */
  base_renewal_cents: number;
  /** Modeled unit COGS — catalog MSRP × (1 − placeholder margin), no real COGS source yet. */
  modeled_cogs_cents: number;
  /** Modeled gross margin fraction on the offer renewal price: (price − cogs) / price. */
  modeled_margin_pct: number;
  /** No per-product COGS source — the model uses the flagged placeholder (M3). */
  cogs_source_missing: boolean;
}

/**
 * Model the renewal margin of an offer using the SAME flagged placeholder economics as the
 * M3 proxy — there is no per-product COGS source yet, so unit COGS is approximated as
 * `catalog MSRP × (1 − PLACEHOLDER_MARGIN_FRACTION)` (i.e. at full price the gross margin is
 * the placeholder). The deeper the offer discount, the lower the modeled margin. Honest, not
 * a new hardcoded economic truth — `cogs_source_missing` is always flagged.
 */
export function modelRenewalMargin(opts: {
  baseMsrpCents: number;
  baseSnsPct: number;
  offer: { offer_type: OfferType; subscribe_discount_pct?: number | null; renewal_price_cents?: number | null };
  marginFraction?: number;
}): MarginModel {
  const marginFraction = opts.marginFraction ?? PLACEHOLDER_MARGIN_FRACTION;
  const msrp = Math.max(0, opts.baseMsrpCents);
  const cogs = Math.round(msrp * (1 - marginFraction));
  const baseRenewal = Math.round(msrp * (1 - Math.max(0, Math.min(100, opts.baseSnsPct)) / 100));

  let offerRenewal: number;
  if (opts.offer.offer_type === "fixed_renewal_price") {
    offerRenewal = Math.max(0, Number(opts.offer.renewal_price_cents ?? baseRenewal));
  } else {
    const pct = Math.max(0, Math.min(100, Number(opts.offer.subscribe_discount_pct ?? opts.baseSnsPct)));
    offerRenewal = Math.round(msrp * (1 - pct / 100));
  }

  const modeledMargin = offerRenewal > 0 ? (offerRenewal - cogs) / offerRenewal : -1;
  return {
    offer_renewal_cents: offerRenewal,
    base_renewal_cents: baseRenewal,
    modeled_cogs_cents: cogs,
    modeled_margin_pct: modeledMargin,
    cogs_source_missing: opts.marginFraction === undefined,
  };
}

export interface MarginVerdict {
  ok: boolean;
  model: MarginModel;
  floor_pct: number;
  /** Human/agent-legible — surfaced in the audit + the escalation. */
  reason: string;
}

/** Evaluate an offer against the configured renewal-margin floor. A breach is BLOCKED. */
export function evaluateOfferMargin(opts: {
  baseMsrpCents: number;
  baseSnsPct: number;
  offer: { offer_type: OfferType; subscribe_discount_pct?: number | null; renewal_price_cents?: number | null };
  floorPct: number;
  marginFraction?: number;
}): MarginVerdict {
  const model = modelRenewalMargin(opts);
  const ok = model.modeled_margin_pct >= opts.floorPct;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return {
    ok,
    model,
    floor_pct: opts.floorPct,
    reason: ok
      ? `modeled renewal margin ${pct(model.modeled_margin_pct)} ≥ floor ${pct(opts.floorPct)} (offer renewal ${(model.offer_renewal_cents / 100).toFixed(2)})`
      : `modeled renewal margin ${pct(model.modeled_margin_pct)} BELOW floor ${pct(opts.floorPct)} — offer would bleed margin past the rail (offer renewal ${(model.offer_renewal_cents / 100).toFixed(2)}, modeled COGS ${(model.modeled_cogs_cents / 100).toFixed(2)})`,
  };
}

// ── Audit (append-only) ─────────────────────────────────────────────────────────

export async function logOfferEvent(
  admin: Admin,
  opts: { workspaceId: string; offerId: string; event: string; actor?: string | null; reason?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from("pricing_rule_offer_events").insert({
      workspace_id: opts.workspaceId,
      offer_id: opts.offerId,
      event: opts.event,
      actor: opts.actor ?? null,
      reason: opts.reason ?? null,
      detail: opts.detail ?? {},
    });
  } catch (e) {
    console.warn(`[renewal-offers] audit log failed (${opts.event} offer=${opts.offerId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Catalog read (for the margin model) ──────────────────────────────────────────

/** The base MSRP + S&S percent for a product, for margin modeling. Best-effort: returns null
 *  when the product has no priced variant. Uses the cheapest active variant as the reference. */
export async function loadProductPricingBasis(
  admin: Admin,
  workspaceId: string,
  productId: string,
): Promise<{ baseMsrpCents: number; baseSnsPct: number; pricingRuleId: string | null } | null> {
  const { data: variant } = await admin
    .from("product_variants")
    .select("price_cents")
    .eq("product_id", productId)
    .not("price_cents", "is", null)
    .order("price_cents", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!variant) return null;
  const baseMsrpCents = Number(variant.price_cents || 0);

  const { data: assign } = await admin
    .from("product_pricing_rule")
    .select("pricing_rule_id")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .maybeSingle();
  const pricingRuleId = (assign?.pricing_rule_id as string | null) ?? null;

  let baseSnsPct = 0;
  if (pricingRuleId) {
    const { data: rule } = await admin
      .from("pricing_rules")
      .select("subscribe_discount_pct")
      .eq("id", pricingRuleId)
      .maybeSingle();
    baseSnsPct = Number(rule?.subscribe_discount_pct ?? 0);
  }
  if (!baseSnsPct) {
    const { data: ws } = await admin.from("workspaces").select("subscription_discount_pct").eq("id", workspaceId).maybeSingle();
    baseSnsPct = Number(ws?.subscription_discount_pct ?? 25);
  }
  return { baseMsrpCents, baseSnsPct, pricingRuleId };
}

// ── Propose (margin-checked, created inactive) ───────────────────────────────────

export interface ProposeOfferResult {
  ok: boolean;
  blocked: boolean;
  offer_id?: string;
  margin: MarginVerdict | null;
  detail: string;
}

/**
 * Create a `proposed` (inactive) persist-to-renewal offer from the agent's typed plan, after
 * the margin-floor check. NEVER activates — only the owner's approval (activateOffer) does.
 * When the modeled margin is below the floor, returns { blocked:true } and writes a
 * `margin_blocked` audit row — the worker escalates to Growth + CFO instead of surfacing it.
 */
export async function proposeOffer(opts: {
  workspaceId: string;
  plan: OfferPlan;
  floorPct: number;
  experimentId?: string | null;
  variantId?: string | null;
  createdBy?: string | null;
  now?: Date;
  admin?: Admin;
}): Promise<ProposeOfferResult> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const p = opts.plan;

  const basis = await loadProductPricingBasis(admin, opts.workspaceId, p.product_id);
  if (!basis) return { ok: false, blocked: false, margin: null, detail: `no priced variant for product ${p.product_id} — cannot model margin` };

  const margin = evaluateOfferMargin({
    baseMsrpCents: basis.baseMsrpCents,
    baseSnsPct: basis.baseSnsPct,
    offer: { offer_type: p.offer_type, subscribe_discount_pct: p.subscribe_discount_pct, renewal_price_cents: p.renewal_price_cents },
    floorPct: opts.floorPct,
  });

  const startsAt = p.starts_at ? new Date(p.starts_at) : now;
  const endsAt = p.ends_at
    ? new Date(p.ends_at)
    : new Date(startsAt.getTime() + DEFAULT_OFFER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Insert the offer record either way (blocked offers are recorded too — supervisability),
  // but a blocked offer stays `proposed` and the worker never surfaces it for approval.
  const { data: row, error } = await admin
    .from("pricing_rule_offers")
    .insert({
      workspace_id: opts.workspaceId,
      product_id: p.product_id,
      pricing_rule_id: basis.pricingRuleId,
      experiment_id: opts.experimentId ?? null,
      variant_id: opts.variantId ?? null,
      lander_type: p.lander_type,
      audience: p.audience || "all",
      offer_type: p.offer_type,
      subscribe_discount_pct: p.offer_type === "subscribe_discount_pct" ? p.subscribe_discount_pct ?? null : null,
      renewal_price_cents: p.offer_type === "fixed_renewal_price" ? p.renewal_price_cents ?? null : null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "proposed",
      modeled_renewal_margin_pct: margin.model.modeled_margin_pct,
      margin_floor_pct: opts.floorPct,
      margin_floor_ok: margin.ok,
      cogs_source_missing: margin.model.cogs_source_missing,
      hypothesis: p.hypothesis ?? null,
      rationale: p.rationale ?? null,
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, blocked: false, margin, detail: `offer insert failed: ${error?.message ?? "no row"}` };
  const offerId = row.id as string;

  await logOfferEvent(admin, {
    workspaceId: opts.workspaceId,
    offerId,
    event: margin.ok ? "proposed" : "margin_blocked",
    actor: "storefront-optimizer",
    reason: margin.reason,
    detail: { margin: margin.model, floor_pct: opts.floorPct, offer_type: p.offer_type },
  });

  if (!margin.ok) {
    return { ok: false, blocked: true, offer_id: offerId, margin, detail: `BLOCKED — ${margin.reason}` };
  }
  return { ok: true, blocked: false, offer_id: offerId, margin, detail: `proposed offer ${offerId} — ${margin.reason}` };
}

// ── Activate (on owner approval) ─────────────────────────────────────────────────

/** Flip a proposed/approved offer → active (persists to renewal). Owner-gated — the worker
 *  calls this only on approval. Refuses a margin-blocked offer (defense in depth). */
export async function activateOffer(opts: {
  workspaceId: string;
  offerId: string;
  approvedBy?: string | null;
  now?: Date;
  admin?: Admin;
}): Promise<{ ok: boolean; detail: string }> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const { data: offer } = await admin
    .from("pricing_rule_offers")
    .select("id, status, margin_floor_ok, ends_at")
    .eq("id", opts.offerId)
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (!offer) return { ok: false, detail: `offer ${opts.offerId} not found` };
  if (offer.margin_floor_ok === false) return { ok: false, detail: `offer ${opts.offerId} is below the margin floor — cannot activate` };
  if (offer.status === "expired") return { ok: false, detail: `offer ${opts.offerId} is expired — cannot reactivate` };
  if (new Date(offer.ends_at as string) <= now) return { ok: false, detail: `offer ${opts.offerId} window already ended — not activating` };

  const { error } = await admin
    .from("pricing_rule_offers")
    .update({ status: "active", approved_by: opts.approvedBy ?? null, approved_at: now.toISOString(), activated_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", opts.offerId);
  if (error) return { ok: false, detail: `activate failed: ${error.message}` };
  await logOfferEvent(admin, { workspaceId: opts.workspaceId, offerId: opts.offerId, event: "activated", actor: opts.approvedBy ?? "owner", reason: "owner approved — offer persists to renewal" });
  return { ok: true, detail: `offer ${opts.offerId} activated` };
}

// ── Deactivate / expire (Phase 3 — reversible on real renewals) ──────────────────

/** Deactivate one offer (status → expired) with an audit reason. The engine then ignores it,
 *  so every bound sub reverts to base renewal pricing on its next renewal — nothing baked. */
export async function deactivateOffer(opts: {
  workspaceId: string;
  offerId: string;
  reason: string;
  event?: string;
  now?: Date;
  admin?: Admin;
}): Promise<{ ok: boolean; detail: string }> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const { error } = await admin
    .from("pricing_rule_offers")
    .update({ status: "expired", expired_at: now.toISOString(), deactivation_reason: opts.reason, updated_at: now.toISOString() })
    .eq("id", opts.offerId)
    .eq("workspace_id", opts.workspaceId)
    .neq("status", "expired");
  if (error) return { ok: false, detail: `deactivate failed: ${error.message}` };
  await logOfferEvent(admin, { workspaceId: opts.workspaceId, offerId: opts.offerId, event: opts.event ?? "expired", reason: opts.reason });
  return { ok: true, detail: `offer ${opts.offerId} deactivated (${opts.reason})` };
}

/** Deactivate every active/approved offer bound to an experiment — called on M1 rollback/kill.
 *  Returns the count touched (affected subs revert to base on their next renewal). */
export async function deactivateOffersForExperiment(opts: {
  experimentId: string;
  reason: string;
  event?: string;
  now?: Date;
  admin?: Admin;
}): Promise<{ count: number }> {
  const admin = opts.admin ?? createAdminClient();
  const { data: offers } = await admin
    .from("pricing_rule_offers")
    .select("id, workspace_id")
    .eq("experiment_id", opts.experimentId)
    .in("status", ["proposed", "approved", "active"]);
  let count = 0;
  for (const o of (offers as Array<{ id: string; workspace_id: string }>) || []) {
    const r = await deactivateOffer({ workspaceId: o.workspace_id, offerId: o.id, reason: opts.reason, event: opts.event ?? "rolled_back", now: opts.now, admin });
    if (r.ok) count++;
  }
  return { count };
}

/** Auto-expire every active offer past its ends_at (the time-box rail). Returns the count. */
export async function expireDueOffers(opts: { workspaceId?: string; now?: Date; admin?: Admin }): Promise<{ count: number }> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  let q = admin
    .from("pricing_rule_offers")
    .select("id, workspace_id")
    .eq("status", "active")
    .lte("ends_at", now.toISOString());
  if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  const { data: due } = await q;
  let count = 0;
  for (const o of (due as Array<{ id: string; workspace_id: string }>) || []) {
    const r = await deactivateOffer({ workspaceId: o.workspace_id, offerId: o.id, reason: "auto_expired (ends_at reached)", event: "expired", now, admin });
    if (r.ok) count++;
  }
  return { count };
}

// ── Resolve (the engine's read) ──────────────────────────────────────────────────

/** The live offer bound to a sub, iff it is active AND within its effective window. Returns
 *  null otherwise (no offer / proposed / expired / out-of-window) → base pricing. The engine
 *  applies the offer ONLY when this returns a row, so deactivation auto-reverts the sub. */
export async function resolveActiveOffer(opts: {
  admin: Admin;
  offerId: string;
  now?: Date;
}): Promise<RenewalOffer | null> {
  const now = opts.now ?? new Date();
  const { data } = await opts.admin
    .from("pricing_rule_offers")
    .select(
      "id, workspace_id, product_id, pricing_rule_id, experiment_id, variant_id, lander_type, audience, offer_type, subscribe_discount_pct, renewal_price_cents, starts_at, ends_at, status, modeled_renewal_margin_pct, margin_floor_pct, margin_floor_ok, cogs_source_missing",
    )
    .eq("id", opts.offerId)
    .maybeSingle();
  if (!data) return null;
  const offer = data as RenewalOffer;
  if (offer.status !== "active") return null;
  if (new Date(offer.starts_at) > now || new Date(offer.ends_at) <= now) return null;
  return offer;
}

// ── Bind on conversion (checkout) ────────────────────────────────────────────────

/**
 * Bind a newly-created subscription to the active offer it converted on, if any. Best-effort
 * (never blocks checkout). A sub qualifies when: an active offer exists for one of the sub's
 * products, AND the converting identity was EXPOSED to that offer's experiment arm (the
 * non-holdout variant) — so only subscribers who actually saw the offer carry it to renewal,
 * not the holdout. Stores a REFERENCE (pricing_rule_offer_id), never a baked price.
 */
export async function bindOfferOnConversion(opts: {
  workspaceId: string;
  subscriptionId: string;
  productIds: string[];
  identityKeys: string[];
  now?: Date;
  admin?: Admin;
}): Promise<{ bound: boolean; offer_id?: string }> {
  const admin = opts.admin ?? createAdminClient();
  const now = opts.now ?? new Date();
  const productIds = [...new Set(opts.productIds.filter(Boolean))];
  const identityKeys = [...new Set(opts.identityKeys.filter(Boolean))];
  if (!productIds.length) return { bound: false };

  try {
    const { data: offers } = await admin
      .from("pricing_rule_offers")
      .select("id, product_id, experiment_id, variant_id, starts_at, ends_at")
      .eq("workspace_id", opts.workspaceId)
      .eq("status", "active")
      .in("product_id", productIds)
      .lte("starts_at", now.toISOString())
      .gt("ends_at", now.toISOString());
    const candidates = (offers as Array<{ id: string; product_id: string; experiment_id: string | null; variant_id: string | null; starts_at: string; ends_at: string }>) || [];
    if (!candidates.length) return { bound: false };

    // Prefer an experiment-scoped offer the identity was actually exposed to (non-holdout).
    if (identityKeys.length) {
      const expIds = [...new Set(candidates.map((c) => c.experiment_id).filter(Boolean) as string[])];
      if (expIds.length) {
        const { data: exposures } = await admin
          .from("storefront_events")
          .select("meta")
          .eq("workspace_id", opts.workspaceId)
          .eq("event_type", "experiment_exposure")
          .or(identityKeys.map((k) => `anonymous_id.eq.${k}`).join(","))
          .order("created_at", { ascending: false })
          .limit(200);
        const exposedVariants = new Set<string>();
        for (const e of (exposures as Array<{ meta: Record<string, unknown> }>) || []) {
          const m = e.meta || {};
          if (m.is_holdout === true) continue;
          const vid = String(m.variant_id ?? "");
          if (vid) exposedVariants.add(vid);
        }
        const matched = candidates.find((c) => c.variant_id && exposedVariants.has(c.variant_id));
        if (matched) {
          await admin.from("subscriptions").update({ pricing_rule_offer_id: matched.id, updated_at: now.toISOString() }).eq("id", opts.subscriptionId);
          await logOfferEvent(admin, { workspaceId: opts.workspaceId, offerId: matched.id, event: "bound_subscription", reason: "converted on offer arm", detail: { subscription_id: opts.subscriptionId } });
          return { bound: true, offer_id: matched.id };
        }
      }
    }
    return { bound: false };
  } catch (e) {
    console.warn(`[renewal-offers] bindOfferOnConversion failed for sub=${opts.subscriptionId}: ${e instanceof Error ? e.message : String(e)}`);
    return { bound: false };
  }
}
