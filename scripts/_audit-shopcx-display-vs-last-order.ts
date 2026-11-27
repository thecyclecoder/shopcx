/**
 * Read-only audit: for every ACTIVE ShopCX-billed subscription, compare the DISPLAYED pre-tax
 * renewal total (the one money resolver `priceSubscription` — the same number the reminder, the
 * next-order journey and the Portal show) against what the sub's LAST paid renewal order actually
 * charged, net of tax. Reports the distribution of the gap so the double-discount fix can be
 * measured ("64 of 70 reminded subs showed a total more than $1 below their last paid order,
 * median gap ~$35, up to $163" — spec). Mutates nothing.
 *
 * Usage:
 *   npx tsx scripts/_audit-shopcx-display-vs-last-order.ts [--workspace=<uuid>] [--limit=<n>]
 */
import { createAdminClient } from "./_bootstrap";
import { priceSubscription } from "@/lib/commerce/price";

type Admin = ReturnType<typeof createAdminClient>;

function parseArgs(argv: string[]): { workspace?: string; limit: number } {
  const out: { workspace?: string; limit: number } = { limit: 5000 };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length)) || out.limit;
  }
  return out;
}

/** Last paid renewal for a sub, reduced to pre-tax cents (net of tax). Null when not comparable. */
async function lastPaidPreTaxCents(admin: Admin, workspaceId: string, subId: string): Promise<number | null> {
  const { data } = await admin
    .from("orders")
    .select("total_cents, avalara_total_tax_cents, payment_details, created_at")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", subId)
    .eq("financial_status", "paid")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const pd = (data.payment_details ?? {}) as Record<string, unknown>;
  const tax =
    data.avalara_total_tax_cents != null
      ? Number(data.avalara_total_tax_cents)
      : pd.tax_cents != null
        ? Number(pd.tax_cents)
        : null;
  if (tax == null) return null;
  return Math.max(0, Number(data.total_cents || 0) - tax);
}

async function main() {
  const { workspace, limit } = parseArgs(process.argv);
  const admin = createAdminClient();

  let q = admin
    .from("subscriptions")
    .select("id, workspace_id, items, is_internal, comp, delivery_price_cents, pricing_offer_id, applied_discounts, shipping_protection_added, shipping_protection_amount_cents")
    .eq("status", "active")
    .eq("billing_source", "shopcx")
    .limit(limit);
  if (workspace) q = q.eq("workspace_id", workspace);
  const { data: subs, error } = await q;
  if (error) throw error;

  const gaps: number[] = [];
  let compared = 0;
  let noPrior = 0;
  let belowBy1Plus = 0; // displayed more than $1 BELOW last paid (the double-discount symptom)

  for (const sub of (subs ?? []) as Array<Record<string, unknown>>) {
    let displayed: number;
    try {
      const { pricing } = await priceSubscription(sub.workspace_id as string, sub);
      displayed = pricing.total_cents;
    } catch {
      continue; // unpriceable line — skip
    }
    const last = await lastPaidPreTaxCents(admin, sub.workspace_id as string, sub.id as string);
    if (last == null) {
      noPrior++;
      continue;
    }
    compared++;
    const gap = displayed - last; // negative = displayed BELOW the real charge
    gaps.push(gap);
    if (gap < -100) belowBy1Plus++;
  }

  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const min = gaps.length ? gaps[0] : 0;
  const max = gaps.length ? gaps[gaps.length - 1] : 0;
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

  console.log("=== ShopCX displayed renewal total vs last paid order (net of tax) ===");
  console.log(`active ShopCX subs scanned : ${(subs ?? []).length}`);
  console.log(`compared (had a prior order): ${compared}`);
  console.log(`skipped (no comparable order): ${noPrior}`);
  console.log(`displayed > $1 BELOW last paid: ${belowBy1Plus}  (the double-discount symptom)`);
  console.log(`gap distribution (displayed − last paid): min ${fmt(min)} · median ${fmt(median)} · max ${fmt(max)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
