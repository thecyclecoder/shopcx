/**
 * cx-agent-sdk — deterministic READ-ONLY CX data SDK for the three box CX agents
 * (Sol / Cora / June). Phase 1 of docs/brain/specs/cx-box-agents-sol-cora-june-
 * deterministic-sdk-toolset-and-brain-access-no-raw-sql.md.
 *
 * The CX box sessions were improvising raw DB queries and missing the right columns —
 * a playbook lookup that turned up empty because chosen_path=playbook got no slug is
 * the derived-from ticket. This SDK gives all three the SAME typed, deterministic
 * read-only surface so their data access is correct by construction, not a guess:
 *
 *   getCxCustomer       — customer + merged identity (all linked customer_ids in the
 *                         same group_id) + primary profile
 *   getCxOrders         — recent orders w/ line items (quantity, charged line total,
 *                         computed per-unit, variant title, subscription_id) — the
 *                         merged-identity fan-out is already applied.
 *   getCxSubscriptions  — subs w/ configured line price_cents / price_override_cents,
 *                         applied_discounts, status, next_billing_date — the merged-
 *                         identity fan-out is already applied.
 *   getCxProducts       — the workspace's active product catalog (variants/flavors/
 *                         pricing) so a variant_title / per-unit compare is deterministic.
 *   getCxPolicies       — the workspace's active `sonnet_prompts` rules the orchestrator
 *                         reads every turn — same source loadLiveRules uses.
 *   getCxBundle         — one Promise.all composing all five.
 *   formatCxBundle      — plain-text snapshot the three prompts embed at the top of
 *                         the prepared bundle so the agents START with the right shape.
 *
 * NEVER mutates. The box sessions call this SDK through scripts/cx-agent-sdk-tool.ts;
 * the deterministic worker (scripts/builder-worker.ts) remains the only mutator via
 * the agents' typed JSON verdicts (writeDirection / applyAnalyzerVerdict / the CS-
 * Director-call executor).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { linkGroupIds } from "@/lib/customer-links";

type Admin = ReturnType<typeof createAdminClient>;

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface CxCustomer {
  /** The primary customer_id passed in. */
  customer_id: string;
  /** All customer_ids in the same link group (linked accounts are one human). */
  linked_customer_ids: string[];
  /** Primary profile — the customer row for the passed customer_id. */
  profile: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    subscription_status: string | null;
    retention_score: number | null;
    email_marketing_status: string | null;
    sms_marketing_status: string | null;
    shopify_customer_id: string | null;
  } | null;
}

export interface CxOrderLine {
  title: string;
  variant_id: string | null;
  variant_title: string | null;
  quantity: number;
  /** The actual per-unit price the customer was charged (line total ÷ qty). */
  per_unit_cents: number;
  /** The line total the customer was charged. */
  line_total_cents: number;
  sku: string | null;
}

export interface CxOrder {
  order_number: string | null;
  shopify_order_id: string | null;
  total_cents: number;
  financial_status: string | null;
  created_at: string;
  source_name: string | null;
  subscription_id: string | null;
  line_items: CxOrderLine[];
}

export interface CxSubscriptionItem {
  title: string;
  variant_id: string | null;
  variant_title: string | null;
  quantity: number;
  /** Configured line price (Shopify contracts). */
  price_cents: number | null;
  /** Configured line override (internal contracts store realized price here). */
  price_override_cents: number | null;
  /** The realized cents per unit — price_cents ?? price_override_cents ?? 0. */
  realized_cents: number;
}

export interface CxSubscriptionDiscount {
  id: string | null;
  title: string | null;
  type: string | null;
  value: number | null;
  value_type: string | null;
}

export interface CxSubscription {
  id: string;
  customer_id: string;
  shopify_contract_id: string | null;
  status: string;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  created_at: string;
  items: CxSubscriptionItem[];
  applied_discounts: CxSubscriptionDiscount[];
}

export interface CxProductVariant {
  id: string;
  title: string | null;
  price_cents: number | null;
}

export interface CxProduct {
  id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  variants: CxProductVariant[];
}

export interface CxPolicy {
  category: string;
  title: string;
  content: string;
}

export interface CxBundle {
  workspace_id: string;
  customer_id: string | null;
  customer: CxCustomer | null;
  orders: CxOrder[];
  subscriptions: CxSubscription[];
  products: CxProduct[];
  policies: CxPolicy[];
}

// ── Getters ───────────────────────────────────────────────────────────────────

const RECENT_ORDER_DAYS = 180;
const RECENT_ORDER_CAP = 25;

/**
 * Customer + merged identity. The linked-accounts group means one human across
 * separate customer rows (different emails, same person); every per-customer
 * query in the SDK is fanned out across the group so a claim on a sibling
 * profile is visible to the agent (Roxana's ticket — see resolveLinkedCustomerIds
 * in sonnet-orchestrator-v2.ts). Uses the shared linkGroupIds helper so the
 * expansion rule can't drift between the SDK and the deployed orchestrator.
 */
export async function getCxCustomer(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CxCustomer> {
  const linked = await linkGroupIds(admin, workspaceId, customerId);
  const { data: c } = await admin
    .from("customers")
    .select(
      "first_name, last_name, email, subscription_status, retention_score, email_marketing_status, sms_marketing_status, shopify_customer_id",
    )
    .eq("id", customerId)
    .maybeSingle();
  return {
    customer_id: customerId,
    linked_customer_ids: linked,
    profile: c
      ? {
          first_name: (c.first_name as string | null) ?? null,
          last_name: (c.last_name as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          subscription_status: (c.subscription_status as string | null) ?? null,
          retention_score: (c.retention_score as number | null) ?? null,
          email_marketing_status: (c.email_marketing_status as string | null) ?? null,
          sms_marketing_status: (c.sms_marketing_status as string | null) ?? null,
          shopify_customer_id: (c.shopify_customer_id as string | null) ?? null,
        }
      : null,
  };
}

/**
 * Recent orders w/ enriched line items. `per_unit_cents` is the ACTUAL charged
 * amount ÷ qty (line total, not the original unit price Shopify stamps pre-
 * discount) — matches the surface computeChargedLineTotals in
 * sonnet-orchestrator-v2 gives the deployed orchestrator, so Cora / Sol / June
 * grade the same numbers the customer sees on their receipt.
 */
export async function getCxOrders(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CxOrder[]> {
  const linked = await linkGroupIds(admin, workspaceId, customerId);
  const since = new Date(Date.now() - RECENT_ORDER_DAYS * 86400_000).toISOString();
  const { data: orders } = await admin
    .from("orders")
    .select(
      "order_number, shopify_order_id, total_cents, line_items, payment_details, financial_status, source_name, subscription_id, created_at",
    )
    .eq("workspace_id", workspaceId)
    .in("customer_id", linked)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(RECENT_ORDER_CAP);
  if (!orders?.length) return [];

  // Pre-fetch variant titles for enrichment (only when there are any variant_ids).
  const variantIds = new Set<string>();
  for (const o of orders) {
    const items = (o.line_items as Array<{ variant_id?: string | null }> | null) ?? [];
    for (const i of items) if (i.variant_id) variantIds.add(String(i.variant_id));
  }
  const variantTitleMap = new Map<string, string>();
  if (variantIds.size > 0) {
    const { data: products } = await admin
      .from("products")
      .select("variants")
      .eq("workspace_id", workspaceId);
    for (const p of products || []) {
      const vs = (p.variants as Array<{ id?: string; title?: string }> | null) ?? [];
      for (const v of vs) {
        if (v.id && v.title) variantTitleMap.set(String(v.id), v.title);
      }
    }
  }

  return orders.map((o) => {
    const rawLines = (o.line_items as Array<{
      title?: string;
      quantity?: number;
      price_cents?: number | null;
      line_total_cents?: number | null;
      total_cents?: number | null;
      sku?: string | null;
      variant_id?: string | null;
      variant_title?: string | null;
    }> | null) ?? [];
    const payment = (o.payment_details as { subtotal_cents?: number | null } | null) ?? null;
    const orderTotal = (o.total_cents as number | null) ?? 0;
    const subtotal = payment?.subtotal_cents ?? orderTotal;
    // Sum of raw line prices × qty — used to scale each line to its realized share
    // of subtotal when the order carries no per-line total.
    const rawSum = rawLines.reduce((acc, l) => acc + Math.round(((l.price_cents ?? 0) * (l.quantity ?? 1))), 0);
    const scale = rawSum > 0 && subtotal > 0 ? subtotal / rawSum : 1;
    return {
      order_number: (o.order_number as string | null) ?? null,
      shopify_order_id: (o.shopify_order_id as string | null) ?? null,
      total_cents: orderTotal,
      financial_status: (o.financial_status as string | null) ?? null,
      created_at: o.created_at as string,
      source_name: (o.source_name as string | null) ?? null,
      subscription_id: (o.subscription_id as string | null) ?? null,
      line_items: rawLines.map((l) => {
        const qty = l.quantity ?? 1;
        // Prefer an explicit line total when present (internal/amplifier orders
        // stamp it); otherwise scale the raw line to its share of the order
        // subtotal (accounts for post-checkout discounts / coupons).
        const lineTotal = l.line_total_cents ?? l.total_cents ?? Math.round((l.price_cents ?? 0) * qty * scale);
        const perUnit = qty > 0 ? Math.round(lineTotal / qty) : 0;
        const resolvedTitle = l.variant_title ?? (l.variant_id ? variantTitleMap.get(String(l.variant_id)) ?? null : null);
        return {
          title: l.title ?? "",
          variant_id: (l.variant_id as string | null) ?? null,
          variant_title: resolvedTitle,
          quantity: qty,
          per_unit_cents: perUnit,
          line_total_cents: lineTotal,
          sku: (l.sku as string | null) ?? null,
        };
      }),
    };
  });
}

/**
 * Active + recent subscriptions w/ configured line pricing (price_cents /
 * price_override_cents), applied_discounts (the JSONB coupons block internal
 * subs + Shopify contracts both persist here), and status. Fan-out across the
 * linked-account group.
 */
export async function getCxSubscriptions(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CxSubscription[]> {
  const linked = await linkGroupIds(admin, workspaceId, customerId);
  const { data: subs } = await admin
    .from("subscriptions")
    .select(
      "id, customer_id, shopify_contract_id, status, items, applied_discounts, billing_interval, billing_interval_count, next_billing_date, created_at",
    )
    .eq("workspace_id", workspaceId)
    .in("customer_id", linked)
    .order("created_at", { ascending: false });
  if (!subs?.length) return [];
  return subs.map((s) => {
    const rawItems = (s.items as Array<{
      title?: string;
      variant_id?: string | null;
      variant_title?: string | null;
      quantity?: number;
      price_cents?: number | null;
      price_override_cents?: number | null;
    }> | null) ?? [];
    const items: CxSubscriptionItem[] = rawItems.map((i) => {
      const price = (i.price_cents as number | null) ?? null;
      const override = (i.price_override_cents as number | null) ?? null;
      return {
        title: i.title ?? "",
        variant_id: (i.variant_id as string | null) ?? null,
        variant_title: (i.variant_title as string | null) ?? null,
        quantity: (i.quantity as number | undefined) ?? 1,
        price_cents: price,
        price_override_cents: override,
        realized_cents: price ?? override ?? 0,
      };
    });
    const rawDiscounts = (s.applied_discounts as Array<{
      id?: string | null;
      title?: string | null;
      type?: string | null;
      value?: number | null;
      valueType?: string | null;
    }> | null) ?? [];
    const applied_discounts: CxSubscriptionDiscount[] = rawDiscounts.map((d) => ({
      id: (d.id as string | null) ?? null,
      title: (d.title as string | null) ?? null,
      type: (d.type as string | null) ?? null,
      value: (d.value as number | null) ?? null,
      value_type: (d.valueType as string | null) ?? null,
    }));
    return {
      id: s.id as string,
      customer_id: s.customer_id as string,
      shopify_contract_id: (s.shopify_contract_id as string | null) ?? null,
      status: (s.status as string) ?? "",
      billing_interval: (s.billing_interval as string | null) ?? null,
      billing_interval_count: (s.billing_interval_count as number | null) ?? null,
      next_billing_date: (s.next_billing_date as string | null) ?? null,
      created_at: s.created_at as string,
      items,
      applied_discounts,
    };
  });
}

/**
 * The workspace's active product catalog — variants (flavors) + pricing so the
 * agents can cite a real variant_title (Berry vs Peach) and compare the AI's
 * per-unit claim against the MSRP. Read-only from `products.status='active'`.
 */
export async function getCxProducts(admin: Admin, workspaceId: string): Promise<CxProduct[]> {
  const { data: products } = await admin
    .from("products")
    .select("id, title, handle, status, variants")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  if (!products?.length) return [];
  return products.map((p) => {
    const vs = (p.variants as Array<{ id?: string; title?: string; price_cents?: number | null }> | null) ?? [];
    return {
      id: p.id as string,
      title: (p.title as string | null) ?? null,
      handle: (p.handle as string | null) ?? null,
      status: (p.status as string | null) ?? null,
      variants: vs
        .filter((v) => !!v.id)
        .map((v) => ({
          id: String(v.id),
          title: (v.title as string | null) ?? null,
          price_cents: (v.price_cents as number | null) ?? null,
        })),
    };
  });
}

/**
 * The workspace's active policies — the SAME `sonnet_prompts` rows the deployed
 * orchestrator reads every turn (loadLiveRules in agent-todos/triage.ts). Enabled
 * + approved only.
 */
export async function getCxPolicies(admin: Admin, workspaceId: string): Promise<CxPolicy[]> {
  const { data } = await admin
    .from("sonnet_prompts")
    .select("category, title, content")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .eq("status", "approved")
    .order("category")
    .order("sort_order");
  if (!data?.length) return [];
  return data.map((p) => ({
    category: (p.category as string) ?? "",
    title: (p.title as string) ?? "",
    content: String(p.content ?? ""),
  }));
}

/**
 * One-shot bundle — every getter above in parallel. Returned as typed data so a
 * caller can render its own shape; formatCxBundle below is the plain-text
 * rendering the three worker briefs embed.
 */
export async function getCxBundle(
  admin: Admin,
  workspaceId: string,
  customerId: string | null,
): Promise<CxBundle> {
  if (!customerId) {
    const [products, policies] = await Promise.all([
      getCxProducts(admin, workspaceId),
      getCxPolicies(admin, workspaceId),
    ]);
    return {
      workspace_id: workspaceId,
      customer_id: null,
      customer: null,
      orders: [],
      subscriptions: [],
      products,
      policies,
    };
  }
  const [customer, orders, subscriptions, products, policies] = await Promise.all([
    getCxCustomer(admin, workspaceId, customerId),
    getCxOrders(admin, workspaceId, customerId),
    getCxSubscriptions(admin, workspaceId, customerId),
    getCxProducts(admin, workspaceId),
    getCxPolicies(admin, workspaceId),
  ]);
  return {
    workspace_id: workspaceId,
    customer_id: customerId,
    customer,
    orders,
    subscriptions,
    products,
    policies,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

const DOLLARS = (cents: number | null | undefined) =>
  cents == null ? "?" : `$${(cents / 100).toFixed(2)}`;

export function formatCxCustomer(c: CxCustomer | null): string {
  if (!c) return "CUSTOMER: (no customer resolved)";
  const linked = c.linked_customer_ids.filter((id) => id !== c.customer_id);
  const linkedLine = linked.length ? ` · linked accounts (same human): ${linked.join(", ")}` : "";
  const p = c.profile;
  if (!p) return `CUSTOMER: ${c.customer_id}${linkedLine} · (profile row not found)`;
  const name = `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "(no name)";
  return `CUSTOMER: ${name} <${p.email ?? ""}> (id ${c.customer_id})${linkedLine} · sub: ${p.subscription_status ?? "none"} · retention: ${p.retention_score ?? 0} · email_marketing: ${p.email_marketing_status ?? "?"} · sms_marketing: ${p.sms_marketing_status ?? "?"}`;
}

export function formatCxOrders(orders: CxOrder[]): string {
  if (!orders.length) return "ORDERS: (none in the last 180 days)";
  const lines: string[] = [`ORDERS (last ${RECENT_ORDER_DAYS} days, cap ${RECENT_ORDER_CAP}):`];
  for (const o of orders) {
    const items = o.line_items
      .map((i) => {
        const variant = i.variant_title ? ` (${i.variant_title})` : "";
        return `${i.title}${variant} x${i.quantity} @ ${DOLLARS(i.per_unit_cents)}/unit (line ${DOLLARS(i.line_total_cents)})`;
      })
      .join(", ");
    const sub = o.subscription_id ? ` · sub ${o.subscription_id}` : " · one-time";
    lines.push(
      `  - #${o.order_number ?? "?"} ${o.created_at.slice(0, 10)} ${DOLLARS(o.total_cents)} ${o.financial_status ?? "?"}${sub}: ${items}`,
    );
  }
  return lines.join("\n");
}

export function formatCxSubscriptions(subs: CxSubscription[]): string {
  if (!subs.length) return "SUBSCRIPTIONS: (none)";
  const lines: string[] = ["SUBSCRIPTIONS:"];
  for (const s of subs) {
    const items = s.items
      .map((i) => {
        const variant = i.variant_title ? ` (${i.variant_title})` : "";
        const src = i.price_cents != null ? "price" : i.price_override_cents != null ? "override" : "?";
        return `${i.title}${variant} x${i.quantity} @ ${DOLLARS(i.realized_cents)} [${src}]`;
      })
      .join(", ");
    const discounts = s.applied_discounts.length
      ? ` · discounts: ${s.applied_discounts.map((d) => `${d.title ?? d.id ?? "?"}${d.value != null ? ` (${d.value_type ?? "?"} ${d.value})` : ""}`).join(", ")}`
      : "";
    const cadence = `every ${s.billing_interval_count ?? 1} ${s.billing_interval ?? "month"}`;
    lines.push(
      `  - ${s.id} [${s.status}] contract: ${s.shopify_contract_id ?? "(internal)"} · ${cadence} · next: ${s.next_billing_date ?? "?"} · ${items}${discounts}`,
    );
  }
  return lines.join("\n");
}

export function formatCxProducts(products: CxProduct[]): string {
  if (!products.length) return "PRODUCTS: (no active products)";
  const lines: string[] = ["PRODUCTS (active — variants + MSRP):"];
  for (const p of products) {
    const variants = p.variants
      .map((v) => `${v.title ?? "(default)"} [${v.id}] @ ${DOLLARS(v.price_cents)}`)
      .join(", ");
    lines.push(`  - ${p.title ?? "(untitled)"} · ${variants || "(no variants)"}`);
  }
  return lines.join("\n");
}

export function formatCxPolicies(policies: CxPolicy[]): string {
  if (!policies.length) return "POLICIES: (no active sonnet_prompts rules)";
  const lines: string[] = ["POLICIES (active sonnet_prompts, category + title + content excerpt):"];
  for (const p of policies) {
    const excerpt = p.content.replace(/\s+/g, " ").slice(0, 400);
    lines.push(`  - [${p.category}] ${p.title}: ${excerpt}`);
  }
  return lines.join("\n");
}

/**
 * Plain-text rendering of the full bundle — the three worker briefs embed this
 * so the agent starts every session with the SAME deterministic snapshot of the
 * customer's data + the workspace's catalog + policies. No raw SQL needed.
 */
export function formatCxBundle(b: CxBundle): string {
  return [
    "--- CX SDK snapshot (deterministic read-only; call the SDK, not raw SQL) ---",
    formatCxCustomer(b.customer),
    formatCxSubscriptions(b.subscriptions),
    formatCxOrders(b.orders),
    formatCxProducts(b.products),
    formatCxPolicies(b.policies),
  ].join("\n");
}

// ── CLI dispatch ──────────────────────────────────────────────────────────────

/** The named verbs the box-side CLI (scripts/cx-agent-sdk-tool.ts) accepts. */
export const CX_SDK_VERBS = [
  "customer",
  "orders",
  "subscriptions",
  "products",
  "policies",
  "bundle",
] as const;
export type CxSdkVerb = (typeof CX_SDK_VERBS)[number];

export function isCxSdkVerb(v: string): v is CxSdkVerb {
  return (CX_SDK_VERBS as readonly string[]).includes(v);
}

/**
 * Dispatch a verb to its formatted text output. The CLI (scripts/cx-agent-sdk-
 * tool.ts) is a very thin wrapper around this — one place tests can exercise
 * the SDK's read + render surface without shelling to node.
 */
export async function runCxSdkVerb(
  admin: Admin,
  verb: CxSdkVerb,
  workspaceId: string,
  customerId: string | null,
): Promise<string> {
  switch (verb) {
    case "customer": {
      if (!customerId) return "CUSTOMER: (no customer resolved on this ticket)";
      const c = await getCxCustomer(admin, workspaceId, customerId);
      return formatCxCustomer(c);
    }
    case "orders": {
      if (!customerId) return "ORDERS: (no customer resolved on this ticket)";
      const o = await getCxOrders(admin, workspaceId, customerId);
      return formatCxOrders(o);
    }
    case "subscriptions": {
      if (!customerId) return "SUBSCRIPTIONS: (no customer resolved on this ticket)";
      const s = await getCxSubscriptions(admin, workspaceId, customerId);
      return formatCxSubscriptions(s);
    }
    case "products": {
      const p = await getCxProducts(admin, workspaceId);
      return formatCxProducts(p);
    }
    case "policies": {
      const p = await getCxPolicies(admin, workspaceId);
      return formatCxPolicies(p);
    }
    case "bundle": {
      const b = await getCxBundle(admin, workspaceId, customerId);
      return formatCxBundle(b);
    }
  }
}
