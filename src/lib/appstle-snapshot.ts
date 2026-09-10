/**
 * Snapshot an Appstle subscription contract into [[docs/brain/tables/appstle_contract_snapshots]].
 *
 * READ-ONLY. Never mutates an Appstle contract — the `check:no-direct-appstle-mutations` guard
 * scopes itself to PUT/POST/DELETE, and everything here is GET.
 *
 * ⭐ Why this exists rather than reading our own `subscriptions` mirror:
 * verified 2026-09-10 on contract 27852046509 — `subscriptions.items[].price_cents` mirrors
 * Appstle's `currentPrice`, which is the price BEFORE discount allocations. That contract's
 * customer actually pays $52.46/unit while the mirror says $59.96. The migration prices off what
 * the customer ACTUALLY pays, so it must read `lineDiscountedPrice` from the source. The mirror
 * also drops SKUs the source carries.
 *
 * ⚠️ Appstle answers an unknown route with **HTTP 200 and its admin SPA's HTML**, not a 404. So
 * `res.ok` proves nothing; every response is sniffed for a leading `<` before parsing.
 */
import { getAppstleCredentials } from "@/lib/appstle";
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";

const APPSTLE_BASE = "https://subscription-admin.appstle.com/api/external/v2";

export interface SnapshotLine {
  sku: string | null;
  variant_id: string | null;
  product_id: string | null;
  title: string | null;
  variant_title: string | null;
  quantity: number;
  /** Per-unit price BEFORE discount allocations — what our mirror stores. Not what they pay. */
  current_price_cents: number | null;
  /** LINE TOTAL after discount allocations (Appstle returns a total here, not a unit price). */
  discounted_total_cents: number | null;
  /** ⭐ What the customer actually pays per unit, INCLUDING any customer discount code. */
  effective_unit_cents: number | null;
  /**
   * ⭐ The portion of this line's discount that comes from a CUSTOMER CODE (loyalty / promo),
   * per unit.
   *
   * The migration recreates structural discounts but CARRIES customer codes, so grandfathering
   * must be computed against the price BEFORE codes — otherwise the code is counted twice: once
   * baked into `effective_unit_cents` and again when re-applied to the new contract. Measured on
   * 27959525549: currentPrice $31.95 x2 with a $15 code gives an effective $24.45/unit, which
   * would mint a permanent $30.72/unit grandfather AND then re-apply the $15.
   */
  code_allocation_unit_cents: number;
  selling_plan_name: string | null;
  discount_allocation_count: number;
}

export interface NormalizedSnapshot {
  status: string | null;
  next_billing_date: string | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  delivery_price_cents: number | null;
  payment_method_id: string | null;
  payment_method_revoked: boolean | null;
  payment_method_type: string | null;
  delivery_method: unknown;
  lines: SnapshotLine[];
}

/** Appstle returns money as a decimal STRING, sometimes with fractional cents ("59.963"). */
function toCents(amount: unknown): number | null {
  if (amount == null) return null;
  const n = typeof amount === "number" ? amount : parseFloat(String(amount));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function lineNodes(raw: Record<string, unknown>): Record<string, unknown>[] {
  const l = raw?.lines as { nodes?: unknown[]; edges?: { node: unknown }[] } | undefined;
  if (Array.isArray(l?.nodes)) return l.nodes as Record<string, unknown>[];
  if (Array.isArray(l?.edges)) return l.edges.map((e) => e.node) as Record<string, unknown>[];
  return [];
}

/** Project the raw Appstle payload into the typed columns. Always re-derivable from `raw`. */
export function normalizeAppstleContract(raw: Record<string, any>): NormalizedSnapshot {
  const bp = raw?.billingPolicy ?? {};
  const pm = raw?.customerPaymentMethod ?? null;
  // Contract-level discounts carry the TYPE; the line allocations carry only an id and an amount.
  // Join them so a line can tell "a code the customer applied" from "a discount Appstle baked in".
  // ⚠️ ONLY fixed-amount codes. The add-back exists so grandfathering is computed against the
  // price BEFORE a code that the migration will RE-APPLY — so it must cover exactly the codes that
  // are actually carried. `carryableCodes` can only re-apply fixed amounts (a percentage code has
  // no `amount.amount`), so including percentage codes here removes their discount from the
  // baseline and never restores it: measured at 94 contracts paying more, +$511.47/cycle, worst
  // case $59.96 -> $110.34. Verify cannot catch that, because both sides are pre-code.
  const codeDiscountIds = new Set<string>(
    ((raw?.discounts?.nodes ?? []) as Record<string, any>[])
      .filter((d) => String(d.type ?? "") === "CODE_DISCOUNT" && d?.value?.amount?.amount != null)
      .map((d) => String(d.id ?? "")),
  );
  const lines: SnapshotLine[] = lineNodes(raw).map((n: any) => {
    const qty = Number(n?.quantity ?? 1) || 1;
    const discountedTotal = toCents(n?.lineDiscountedPrice?.amount);
    const codeTotal = ((n?.discountAllocations ?? []) as Record<string, any>[])
      .filter((a) => codeDiscountIds.has(String(a?.discount?.id ?? "")))
      .reduce((sum, a) => sum + (toCents(a?.amount?.amount) ?? 0), 0);
    return {
      sku: n?.sku ?? null,
      variant_id: n?.variantId ? String(n.variantId).replace("gid://shopify/ProductVariant/", "") : null,
      product_id: n?.productId ? String(n.productId).replace("gid://shopify/Product/", "") : null,
      title: n?.title ?? null,
      variant_title: n?.variantTitle ?? null,
      quantity: qty,
      current_price_cents: toCents(n?.currentPrice?.amount),
      discounted_total_cents: discountedTotal,
      // lineDiscountedPrice is a LINE TOTAL; divide to get the per-unit rate the customer pays.
      effective_unit_cents: discountedTotal != null ? Math.round(discountedTotal / qty) : null,
      code_allocation_unit_cents: Math.round(codeTotal / qty),
      selling_plan_name: n?.sellingPlanName ?? null,
      discount_allocation_count: Array.isArray(n?.discountAllocations) ? n.discountAllocations.length : 0,
    };
  });
  return {
    status: raw?.status ?? null,
    next_billing_date: raw?.nextBillingDate ?? null,
    billing_interval: bp?.interval ?? null,
    billing_interval_count: bp?.intervalCount ?? null,
    delivery_price_cents: toCents(raw?.deliveryPrice?.amount),
    payment_method_id: pm?.id ?? null,
    payment_method_revoked: pm ? pm.revokedAt != null : null,
    payment_method_type: pm?.instrument?.__typename ?? null,
    delivery_method: raw?.deliveryMethod ?? null,
    lines,
  };
}

export type FetchResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string; rateLimited?: boolean };

/** GET one contract. Read-only. */
export async function fetchAppstleContract(workspaceId: string, contractId: string): Promise<FetchResult> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { ok: false, error: "Appstle not configured" };
  try {
    const res = await fetch(
      `${APPSTLE_BASE}/subscription-contracts/contract-external/${contractId}?api_key=${creds.apiKey}`,
      { headers: { "X-API-Key": creds.apiKey } },
    );
    if (res.status === 429 || res.status === 503) {
      return { ok: false, error: `rate limited (HTTP ${res.status})`, rateLimited: true };
    }
    const text = await res.text();
    // ⚠️ Appstle serves its SPA (HTTP 200, HTML) for unknown routes. res.ok is not evidence.
    if (text.trimStart().startsWith("<")) {
      return { ok: false, error: `Appstle returned HTML (HTTP ${res.status}) — route miss or contract not found` };
    }
    if (!res.ok) return { ok: false, error: `Appstle HTTP ${res.status}: ${text.slice(0, 200)}` };
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return { ok: false, error: "Appstle returned a non-object body" };
    return { ok: true, raw };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/**
 * Fetch + upsert one contract's snapshot.
 *
 * A FAILED fetch still writes a row (with `fetch_error` set and `raw` null). A missing row would
 * be indistinguishable from "never attempted", which is the exact silent-gap class this table is
 * meant to close.
 */
export async function snapshotAppstleContract(
  workspaceId: string,
  appstleContractId: string,
  subscriptionId: string | null,
): Promise<{ ok: boolean; error?: string; rateLimited?: boolean }> {
  const admin = createAdminClient();
  const got = await fetchAppstleContract(workspaceId, appstleContractId);
  const base = {
    workspace_id: workspaceId,
    appstle_contract_id: appstleContractId,
    subscription_id: subscriptionId,
    fetched_at: new Date().toISOString(),
  };
  const row = got.ok
    ? { ...base, ...normalizeAppstleContract(got.raw as Record<string, any>), raw: got.raw, fetch_error: null }
    : { ...base, raw: null, fetch_error: got.error, lines: [] };

  const { error } = await admin
    .from("appstle_contract_snapshots")
    .upsert(row, { onConflict: "workspace_id,appstle_contract_id" });
  if (error) return { ok: false, error: `snapshot upsert failed: ${error.message}` };
  return got.ok ? { ok: true } : { ok: false, error: got.error, rateLimited: got.rateLimited };
}
