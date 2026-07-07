/**
 * Offers SDK — the admin-layer over pricing rules that attaches extra
 * included products to a variant order.
 *
 * Phase 1 of `offer-creator`: this file exposes typed reads/writes for
 * the `public.offers` table + the shape helpers Phase 2 (cart-build)
 * and Phase 3 (renewal-strip) will consume.
 *
 * See docs/brain/tables/offers.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type OfferKind = "physical" | "digital";
export type OfferScope = "checkout_only" | "checkout_and_renewals";

export interface OfferIncluded {
  /**
   * Physical → `product_variants.id` (Amplifier sku-bearing line).
   * Digital  → `digital_goods.id` (no sku, triggers digital-goods-delivery).
   */
  ref_id: string;
  kind: OfferKind;
  quantity: number;
}

export interface Offer {
  id: string;
  workspace_id: string;
  variant_id: string;
  name: string | null;
  included: OfferIncluded[];
  scope: OfferScope;
  overrides_pricing_rule_gifts: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OfferInput {
  variant_id: string;
  name?: string | null;
  included: OfferIncluded[];
  scope?: OfferScope;
  overrides_pricing_rule_gifts?: boolean;
  is_active?: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeIncluded(raw: unknown): OfferIncluded[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferIncluded[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const ref = typeof r.ref_id === "string" ? r.ref_id : "";
    const kind = r.kind === "digital" ? "digital" : r.kind === "physical" ? "physical" : null;
    const qtyN = typeof r.quantity === "number" ? r.quantity : Number(r.quantity);
    if (!UUID_RE.test(ref) || !kind || !Number.isFinite(qtyN) || qtyN < 1) continue;
    out.push({ ref_id: ref, kind, quantity: Math.floor(qtyN) });
  }
  return out;
}

export function normalizeScope(raw: unknown): OfferScope {
  return raw === "checkout_and_renewals" ? "checkout_and_renewals" : "checkout_only";
}

export async function listOffersForWorkspace(workspaceId: string): Promise<Offer[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("offers")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(hydrateOffer);
}

export async function getOffer(workspaceId: string, offerId: string): Promise<Offer | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("offers")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", offerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? hydrateOffer(data) : null;
}

/** Cart-build (Phase 2) lookup — the active offer attached to a variant. */
export async function getActiveOfferForVariant(
  workspaceId: string,
  variantId: string,
): Promise<Offer | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("offers")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("variant_id", variantId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? hydrateOffer(data) : null;
}

export async function createOffer(workspaceId: string, input: OfferInput): Promise<Offer> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("offers")
    .insert({
      workspace_id: workspaceId,
      variant_id: input.variant_id,
      name: input.name ?? null,
      included: normalizeIncluded(input.included),
      scope: normalizeScope(input.scope),
      overrides_pricing_rule_gifts: Boolean(input.overrides_pricing_rule_gifts),
      is_active: input.is_active ?? true,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return hydrateOffer(data);
}

export async function updateOffer(
  workspaceId: string,
  offerId: string,
  patch: Partial<OfferInput>,
): Promise<void> {
  const admin = createAdminClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.variant_id === "string") updates.variant_id = patch.variant_id;
  if ("name" in patch) updates.name = patch.name ?? null;
  if (Array.isArray(patch.included)) updates.included = normalizeIncluded(patch.included);
  if (typeof patch.scope === "string") updates.scope = normalizeScope(patch.scope);
  if (typeof patch.overrides_pricing_rule_gifts === "boolean") {
    updates.overrides_pricing_rule_gifts = patch.overrides_pricing_rule_gifts;
  }
  if (typeof patch.is_active === "boolean") updates.is_active = patch.is_active;

  const { error } = await admin
    .from("offers")
    .update(updates)
    .eq("id", offerId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
}

export async function deleteOffer(workspaceId: string, offerId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("offers")
    .delete()
    .eq("id", offerId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
}

function hydrateOffer(row: Record<string, unknown>): Offer {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    variant_id: String(row.variant_id),
    name: (row.name as string | null) ?? null,
    included: normalizeIncluded(row.included),
    scope: normalizeScope(row.scope),
    overrides_pricing_rule_gifts: Boolean(row.overrides_pricing_rule_gifts),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
