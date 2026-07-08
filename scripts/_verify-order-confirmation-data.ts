/**
 * Verify getShopifyOrderEmailData across the three real order shapes
 * that hit the resolver in prod: (a) a recent web order (source=web),
 * (b) a subscription renewal (source contains 'subscription',
 * payment_details null), (c) a POS/other-source order. For each the
 * script asserts:
 *
 *   1. every returned line has a non-null image_url + product_id;
 *   2. variant_title is populated on every line;
 *   3. subtotal_cents + tax_cents + shipping_cents === total_cents
 *      (reconciles to the stored orders.total_cents).
 *
 * Read-only. Prints one row per case + a PASS/FAIL summary; exits 1
 * on failure so a `_verify-*` cron / CI wire can gate on it.
 *
 * Usage:
 *   npx tsx scripts/_verify-order-confirmation-data.ts [workspaceId]
 * (workspaceId defaults to the Superfoods workspace when omitted; the
 * script picks the newest matching order per case.)
 */
import { createAdminClient } from "./_bootstrap";
import { getShopifyOrderEmailData } from "../src/lib/order-confirmation-data";

const DEFAULT_WORKSPACE_ID = process.argv[2] || process.env.SUPERFOODS_WORKSPACE_ID || "";

const COLS =
  "id, workspace_id, customer_id, shopify_order_id, order_number, email, total_cents, line_items, shipping_address, shipping_method_code, payment_details, subscription_id, shipping_protection_added, shipping_protection_amount_cents, source_name, amplifier_tracking_number, amplifier_carrier";

async function findWorkspace(): Promise<string> {
  if (DEFAULT_WORKSPACE_ID) return DEFAULT_WORKSPACE_ID;
  const admin = createAdminClient();
  const { data } = await admin.from("workspaces").select("id, name").limit(1);
  const row = (data as { id: string }[] | null)?.[0];
  if (!row) throw new Error("No workspace found — pass workspaceId as argv[2].");
  return row.id;
}

async function pickWebOrder(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .not("shopify_order_id", "is", null)
    .in("source_name", ["web"])
    .is("subscription_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data as { id: string }[] | null)?.[0]?.id || null;
}

async function pickSubscriptionRenewal(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("orders")
    .select("id, source_name")
    .eq("workspace_id", workspaceId)
    .not("shopify_order_id", "is", null)
    .not("subscription_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);
  const list = (data as { id: string; source_name: string | null }[] | null) || [];
  const match = list.find((r) => (r.source_name || "").toLowerCase().includes("subscription")) || list[0];
  return match?.id || null;
}

async function pickOtherOrder(workspaceId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .not("shopify_order_id", "is", null)
    .not("source_name", "in", "(web)")
    .is("subscription_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data as { id: string }[] | null)?.[0]?.id || null;
}

interface CaseResult {
  label: string;
  orderId: string | null;
  passed: boolean;
  reasons: string[];
  storedTotal: number;
  computedTotal: number;
  usedGraphQL: boolean;
  linesMissingImage: number;
  linesMissingProductId: number;
  linesMissingVariantTitle: number;
  linesTotal: number;
}

async function verifyOne(label: string, orderId: string | null): Promise<CaseResult> {
  const reasons: string[] = [];
  if (!orderId) {
    return {
      label,
      orderId: null,
      passed: false,
      reasons: [`no matching order found for '${label}'`],
      storedTotal: 0,
      computedTotal: 0,
      usedGraphQL: false,
      linesMissingImage: 0,
      linesMissingProductId: 0,
      linesMissingVariantTitle: 0,
      linesTotal: 0,
    };
  }
  const admin = createAdminClient();
  const { data: row } = await admin.from("orders").select(COLS).eq("id", orderId).maybeSingle();
  if (!row) {
    return {
      label,
      orderId,
      passed: false,
      reasons: ["order row disappeared between pick and read"],
      storedTotal: 0,
      computedTotal: 0,
      usedGraphQL: false,
      linesMissingImage: 0,
      linesMissingProductId: 0,
      linesMissingVariantTitle: 0,
      linesTotal: 0,
    };
  }
  const { order, isFirstOrder, subscribing, nextBillingDate, usedGraphQL } =
    await getShopifyOrderEmailData(row as never);
  const pd = order.payment_details || {};
  const subtotal = pd.subtotal_cents ?? 0;
  const tax = pd.tax_cents ?? 0;
  const shipping = pd.shipping_cents ?? 0;
  const computedTotal = subtotal + tax + shipping;
  const storedTotal = order.total_cents;

  const linesMissingImage = order.line_items.filter((l) => !l.image_url).length;
  const linesMissingProductId = order.line_items.filter(
    (l) => !(l as { product_id?: string | null }).product_id,
  ).length;
  const linesMissingVariantTitle = order.line_items.filter((l) => !l.variant_title).length;

  if (order.line_items.length === 0) reasons.push("no line items on order");
  if (linesMissingImage > 0) reasons.push(`${linesMissingImage} line(s) missing image_url`);
  if (linesMissingProductId > 0) reasons.push(`${linesMissingProductId} line(s) missing product_id`);
  if (linesMissingVariantTitle > 0)
    reasons.push(`${linesMissingVariantTitle} line(s) missing variant_title`);
  if (computedTotal !== storedTotal)
    reasons.push(
      `subtotal+tax+shipping=${computedTotal}¢ does not reconcile to stored total=${storedTotal}¢`,
    );

  return {
    label,
    orderId,
    passed: reasons.length === 0,
    reasons,
    storedTotal,
    computedTotal,
    usedGraphQL,
    linesMissingImage,
    linesMissingProductId,
    linesMissingVariantTitle,
    linesTotal: order.line_items.length,
    // Expose the derived send flags so the printout doubles as a
    // sanity check on isFirstOrder / subscribing / nextBillingDate.
    ...(({
      _isFirstOrder: isFirstOrder,
      _subscribing: subscribing,
      _nextBillingDate: nextBillingDate,
    }) as unknown as Record<string, unknown>),
  };
}

async function main() {
  const workspaceId = await findWorkspace();
  console.log(`[verify-order-confirmation] workspace=${workspaceId}`);
  const [web, renewal, other] = await Promise.all([
    pickWebOrder(workspaceId),
    pickSubscriptionRenewal(workspaceId),
    pickOtherOrder(workspaceId),
  ]);
  const results: CaseResult[] = [];
  results.push(await verifyOne("web", web));
  results.push(await verifyOne("subscription_renewal", renewal));
  results.push(await verifyOne("other_source", other));
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    console.log(
      `[${tag}] ${r.label} orderId=${r.orderId ?? "-"} lines=${r.linesTotal} usedGraphQL=${r.usedGraphQL} stored_total=${r.storedTotal}¢ computed_total=${r.computedTotal}¢`,
    );
    for (const reason of r.reasons) console.log(`       - ${reason}`);
  }
  const allPassed = results.every((r) => r.passed);
  console.log(allPassed ? "OK — all three cases passed" : "FAIL — one or more cases failed");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify-order-confirmation] fatal", err);
  process.exit(1);
});
