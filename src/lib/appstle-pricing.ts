/**
 * Appstle pricing heal + the single mutation gateway.
 *
 * Appstle's original migration collapsed "$79.95 base − 25%" into a flat low
 * price with `pricingPolicy: null` on a chunk of subs. Those subs don't re-apply
 * the S&S discount on modification, and they're a double-discount landmine for our
 * internal pricing engine. This module:
 *
 *   1. inferAppstleLineBase — the ONE pricing-inference function. Reads
 *      pricingPolicy.basePrice when present; reverse-engineers currentPrice/(1−sns)
 *      when null (preserving the customer's charge). Shared by the heal AND the
 *      migration ([[migrate-to-internal]]).
 *   2. healAppstleContract — idempotent. For each line with pricingPolicy === null,
 *      writes a proper basePrice + S&S cycle discount via Appstle's
 *      update-line-item-pricing-policy endpoint. Preserves the charge; no-op once
 *      every line is structured. (Appstle emails are disabled, so the endpoint's
 *      price-update email is moot.)
 *   3. appstleMutate — the chokepoint. Every Appstle CONTRACT MUTATION routes
 *      through it; it heals null-policy lines before running the action. `skipHeal`
 *      for migration (heal-by-migration) and billing-only actions.
 *
 * See docs/brain/specs/appstle-pricing-heal-and-migration-monitor.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { loggedAppstleFetch } from "@/lib/appstle-call-log";
import { isInternalSubscription } from "@/lib/internal-subscription";

type Admin = ReturnType<typeof createAdminClient>;

// Inlined (not imported from subscription-items) to avoid an import cycle —
// subscription-items + appstle both import THIS module for the gateway.
async function getAppstleKey(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).maybeSingle();
  return ws?.appstle_api_key_encrypted ? decrypt(ws.appstle_api_key_encrypted) : null;
}

// ── Pricing inference ────────────────────────────────────────────────

export interface AppstleLine {
  id?: string; // gid://shopify/SubscriptionLine/...
  variantId?: string;
  title?: string;
  variantTitle?: string;
  quantity?: number;
  currentPrice?: { amount?: string } | null;
  pricingPolicy?: { basePrice?: { amount?: string } | null } | null;
}

export interface InferredBase {
  trueBaseCents: number;
  isGrandfathered: boolean;
  /** Where the base came from — for logging / monitor clarity. */
  source: "pricing_policy" | "reverse_engineered";
}

const toCents = (amt: string | undefined | null): number => Math.round(parseFloat(String(amt ?? "0")) * 100);

/**
 * Infer a line's true (pre-S&S) base price.
 *
 * - pricingPolicy present → basePrice IS the true base (isolates it from any
 *   stacked discount baked into currentPrice, and uses the real structure).
 * - pricingPolicy null → reverse-engineer from currentPrice so the engine
 *   reproduces the exact charge: base = currentPrice / (1 − sns).
 *
 * Grandfathered when the true base is below catalog MSRP.
 */
export function inferAppstleLineBase(line: AppstleLine, catalogMsrpCents: number, snsPct: number): InferredBase {
  const basePriceCents = line.pricingPolicy?.basePrice?.amount != null ? toCents(line.pricingPolicy.basePrice.amount) : 0;
  if (basePriceCents > 0) {
    return { trueBaseCents: basePriceCents, isGrandfathered: catalogMsrpCents > 0 && basePriceCents < catalogMsrpCents, source: "pricing_policy" };
  }
  const currentCents = toCents(line.currentPrice?.amount);
  const factor = 1 - snsPct / 100;
  const trueBaseCents = factor > 0 ? Math.round(currentCents / factor) : currentCents;
  return { trueBaseCents, isGrandfathered: catalogMsrpCents > 0 && trueBaseCents < catalogMsrpCents, source: "reverse_engineered" };
}

/** Per-product subscribe-discount % → workspace default (matches the internal engine). */
export async function resolveLineSnsPct(admin: Admin, workspaceId: string, productId: string | null | undefined): Promise<number> {
  const { data: ws } = await admin.from("workspaces").select("subscription_discount_pct").eq("id", workspaceId).maybeSingle();
  const fallback = (ws?.subscription_discount_pct as number | undefined) ?? 25;
  if (!productId) return fallback;
  const { data: assign } = await admin.from("product_pricing_rule").select("pricing_rule_id").eq("workspace_id", workspaceId).eq("product_id", productId).maybeSingle();
  if (!assign?.pricing_rule_id) return fallback;
  const { data: rule } = await admin.from("pricing_rules").select("subscribe_discount_pct").eq("id", assign.pricing_rule_id).maybeSingle();
  return (rule?.subscribe_discount_pct as number | undefined) ?? fallback;
}

// ── Heal ─────────────────────────────────────────────────────────────

export interface HealResult {
  healedLines: number;
  alreadyStructured: number;
  failed: number;
  skippedNoCatalog: number;
}

/** Catalog MSRP + product_id for a Shopify variant id. */
async function catalogForVariant(admin: Admin, shopifyVariantId: string): Promise<{ productId: string | null; msrpCents: number } | null> {
  const { data: v } = await admin
    .from("product_variants")
    .select("product_id, price_cents")
    .eq("shopify_variant_id", shopifyVariantId)
    .maybeSingle();
  if (!v) return null;
  return { productId: (v.product_id as string) || null, msrpCents: (v.price_cents as number) || 0 };
}

/**
 * Heal a contract's pricing structure. Idempotent: only lines with
 * `pricingPolicy === null` get a policy written; everything else is a read-only
 * no-op. Preserves each line's current charge. Returns a summary.
 */
export async function healAppstleContract(workspaceId: string, contractId: string): Promise<HealResult> {
  const result: HealResult = { healedLines: 0, alreadyStructured: 0, failed: 0, skippedNoCatalog: 0 };
  // Internal subs aren't on Appstle.
  if (await isInternalSubscription(workspaceId, contractId)) return result;
  const apiKey = await getAppstleKey(workspaceId);
  if (!apiKey) return result;
  const admin = createAdminClient();

  const r = await loggedAppstleFetch(
    `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
    { headers: { "X-API-Key": apiKey }, cache: "no-store" },
  );
  if (!r.ok) return result;
  const contract = await r.json().catch(() => null);
  if (!contract || contract.status === "CANCELLED") return result;

  const lines: AppstleLine[] = (contract.lines?.nodes as AppstleLine[]) || (contract.lines?.edges as Array<{ node: AppstleLine }>)?.map((e) => e.node) || [];
  for (const line of lines) {
    if (line.pricingPolicy?.basePrice?.amount != null) { result.alreadyStructured++; continue; }
    if (!line.id) { result.failed++; continue; }
    const shopifyVariantId = String(line.variantId || "").split("/").pop() || "";
    const cat = shopifyVariantId ? await catalogForVariant(admin, shopifyVariantId) : null;
    if (!cat) { result.skippedNoCatalog++; continue; }
    const snsPct = await resolveLineSnsPct(admin, workspaceId, cat.productId);
    const { trueBaseCents } = inferAppstleLineBase(line, cat.msrpCents, snsPct);
    if (trueBaseCents <= 0) { result.skippedNoCatalog++; continue; }

    const basePrice = (trueBaseCents / 100).toFixed(2);
    const cycles = [{ afterCycle: 0, discountType: "PERCENTAGE", value: snsPct }];
    const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-line-item-pricing-policy?contractId=${contractId}&lineId=${encodeURIComponent(line.id)}&basePrice=${basePrice}`;
    try {
      const pr = await loggedAppstleFetch(url, {
        method: "PUT",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(cycles),
        cache: "no-store",
      });
      if (pr.ok) result.healedLines++;
      else { result.failed++; console.error(`[appstle-heal] PUT ${pr.status} for ${contractId}/${line.id}`); }
    } catch (e) {
      result.failed++;
      console.error(`[appstle-heal] threw for ${contractId}/${line.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}

// ── Gateway ──────────────────────────────────────────────────────────

/**
 * Heal guard — the gateway's heal step, callable as a single line. Drop this at
 * the top of every Appstle mutation (after the internal short-circuit) so no
 * modification ever lands on an unstructured sub. Non-fatal: a heal hiccup never
 * blocks the customer's action. Idempotent + cheap once a sub is structured.
 */
export async function healOnTouch(workspaceId: string, contractId: string): Promise<void> {
  try {
    await healAppstleContract(workspaceId, contractId);
  } catch (e) {
    console.error(`[appstle-heal] healOnTouch failed (non-fatal) for ${contractId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Closure form of the chokepoint, for call sites that aren't already a tidy
 * wrapper (the direct-fetch handlers). Heals null-policy lines, then runs `fn`.
 * `skipHeal: true` for migration (heal-by-migration) and billing-only actions.
 */
export async function appstleMutate<T>(
  workspaceId: string,
  contractId: string,
  opts: { skipHeal?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  if (!opts.skipHeal) await healOnTouch(workspaceId, contractId);
  return fn();
}
