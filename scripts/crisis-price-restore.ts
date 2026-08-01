/**
 * crisis-price-restore — put back the grandfathered prices my crisis swap reset.
 *
 * WHAT HAPPENED (2026-07-30, self-inflicted)
 * `crisis-restore.ts` / `crisis-create-sl.ts` swapped variants with `subscriptionSwapVariant` and
 * never carried the LINE PRICE across. An Appstle variant replacement creates a NEW line at catalog
 * price, so every swapped sub silently jumped to the standard rate. Proven on ja0620@gmail.com:
 * order SC135753 (2026-07-29) billed Superfood Tabs ×3 at $26.65/unit with zero line discount; after
 * the 7/30 swap the line reads $59.96. The ORIGINAL April crisis swap preserved their price.
 *
 * The brain calls this out as the thing not to do ([[../docs/brain/lifecycles/crisis-campaign]] §
 * Pricing preservation): "crisis swaps shouldn't be a pricing event for the customer — we caused the
 * inconvenience, they shouldn't pay more for it."
 *
 * ── THE PRICE MODEL (get this wrong and you move money the wrong way) ──────────────────────────
 * Three different numbers, easy to conflate — see [[../docs/brain/recipes/change-line-item-price]]
 * and [[../docs/brain/libraries/appstle-pricing]]:
 *
 *   MSRP / base   $79.95   catalog `product_variants.price_cents`; what `subUpdateLineItemPrice` TAKES
 *   realized      $59.96   base × (1 − sns).  ← `subscriptions.items[].price_cents` AND live `currentPrice`
 *   post-coupon   $47.97   realized × code discount.  ← live `lineDiscountedPrice`
 *
 * `orders.line_items[].price_cents` is the per-unit REALIZED price (verified: qty 3 × $26.65 =
 * $79.95 subtotal). So the customer-comparable pair is order-realized vs sub-realized, and the value
 * to WRITE is `realized / (1 − sns)` — the `restore_base_cents` formula from
 * [[../docs/brain/libraries/subscription-overcharge]]. Passing a realized price straight into
 * `subUpdateLineItemPrice` double-discounts it (the first canary run did exactly that and set 5 subs
 * 25% low; `CANARY_UNDERCHARGED` below repairs exactly those, by contract id).
 *
 * ── THE BASELINE MUST BE A RENEWAL ORDER, NOT "THEIR LAST ORDER" ──────────────────────────────
 * Baselining on the customer's most recent order of this product is WRONG: a one-time full-price
 * purchase then reads as the established rate. A dry run of that version wanted to RAISE ~20 healthy
 * subs from $59.96 to $79.95 (e.g. deborahanndonahue@yahoo.com — sub bills the normal S&S price, no
 * renewal history at all, last order a $79.95 one-off). `subscription-overcharge` gets this right and
 * this follows it: the baseline is the last order **on this subscription** (`orders.subscription_id`),
 * excluding drafts. A sub with no renewal history has no established rate and is left alone.
 *
 * ── THE FLOOR, AND WHY THIS DEVIATES ──────────────────────────────────────────────────────────
 * `subscription-overcharge` clamps an inferred baseline UP to the 50%-MSRP floor ($39.98 realized
 * here). This script does NOT clamp. That guardrail protects against restoring off a stale INFERRED
 * baseline; here the reference is a real order from the last few weeks, and clamping up would RAISE
 * customers above the price they were actually paying — the exact harm being undone. Restoring what
 * they demonstrably paid is an undo, not a pricing decision.
 *
 * DISCIPLINE
 * - Target is always the customer's own last-paid realized price. Never above it.
 * - VERIFY-AFTER, in realized terms. `subUpdateLineItemPrice` → `callReplaceVariants` returns
 *   `{success:true}` on any 2xx without reading the body (spec
 *   `a-subscription-mutation-must-verify-it-happened-not-trust-http-200`; two contracts silently
 *   no-opped on 2026-07-30). Every write is re-read from the LIVE contract.
 * - Idempotent: a line already realizing last-paid (±2¢) is skipped, so re-runs are free.
 *
 *   npx tsx scripts/crisis-price-restore.ts                    # dry run — full plan
 *   npx tsx scripts/crisis-price-restore.ts --apply --limit 5  # canary
 *   npx tsx scripts/crisis-price-restore.ts --apply            # the rest
 */
import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
const LIMIT = arg("--limit") ? Math.max(1, Number(arg("--limit"))) : Infinity;
const CONCURRENCY = arg("--concurrency") ? Math.max(1, Math.min(8, Number(arg("--concurrency")))) : 4;
const TOL = 2; // cents

/**
 * The 5 contracts the first canary run set 25% low (it passed a realized price where MSRP was
 * expected). These are the ONLY subs this script is allowed to RAISE, and only ever back to their
 * own last renewal price. Listed explicitly rather than pattern-matched: the pattern
 * (`live == lastPaid × 0.75`) is indistinguishable from a healthy sub whose last order was a
 * full-price one-off, so a heuristic here would raise real customers' prices.
 */
const CANARY_UNDERCHARGED = new Set([
  "27810922669", // nvenzon@team-construction.com
  "27820261549", // dmraehsler@gmail.com
  "27830157485", // kathryn.sherman@att.net
  "27819180205", // simseyyx33@aol.com
  "28135194797", // srich1@cox.net
]);

const LOG_PATH = process.env.PRICE_RESTORE_LOG
  || `/private/tmp/claude-501/-Users-admin-Projects-shopcx/219f28b6-db60-4a01-a85f-78b760e5cc02/scratchpad/price-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
function logLine(e: Record<string, unknown>) {
  try { mkdirSync(dirname(LOG_PATH), { recursive: true }); appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"); } catch {}
}

interface Target {
  contractId: string; subId: string; internal: boolean; email: string;
  variantId: string; productId: string | null;
  liveRealized: number;   // what the sub bills today, per unit
  lastPaid: number;       // what they last actually paid, per unit
  writeBase: number;      // computed at run time once sns is known
  reason: "overcharge" | "undercharge";
  lastOrder: string | null;
}

async function main() {
  const c = pgClient(); await c.connect();
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");
  let rows: any[] = [];
  try {
    // live realized (subscriptions.items) vs the last RENEWAL price on this same subscription.
    rows = (await c.query(`
      select distinct on (s.id)
        s.id sub_id, s.shopify_contract_id, coalesce(s.is_internal,false) internal, cu.email,
        live.variant_id, live.cents live_realized, lo.unit last_paid, lo.created_at last_order_at,
        pv.product_id
      from crisis_customer_actions a
      join subscriptions s on s.id = a.subscription_id and s.status in ('active','paused')
      join customers cu on cu.id = a.customer_id
      cross join lateral (
          -- the established rate = what THIS subscription last actually billed
          select o.created_at, (i->>'price_cents')::int unit
          from orders o
          cross join lateral jsonb_array_elements(o.line_items) i
          where o.subscription_id = s.id
            and coalesce(o.source_name,'') <> 'shopify_draft_order'
            and i->>'sku' like 'SC-TABS%' and (i->>'price_cents')::int > 0
          order by o.created_at desc limit 1
        ) lo
      cross join lateral (
          select (i->>'price_cents')::int cents, i->>'variant_id' variant_id
          from jsonb_array_elements(s.items) i
          where i->>'sku' like 'SC-TABS%' and (i->>'price_cents')::int > 0
          order by (i->>'price_cents')::int desc limit 1
        ) live
      left join product_variants pv on pv.workspace_id = $1 and pv.shopify_variant_id = live.variant_id
      where a.restored_at is not null
      order by s.id, live.cents desc`, [W])).rows;
  } finally { await c.end(); }

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { resolveLineSnsPct } = await import("../src/lib/appstle-pricing");
  const admin = createAdminClient() as any;
  const snsCache = new Map<string, number>();
  const snsFor = async (pid: string | null) => {
    const k = pid ?? "-";
    if (!snsCache.has(k)) snsCache.set(k, await resolveLineSnsPct(admin, W, pid));
    return snsCache.get(k)!;
  };

  const targets: Target[] = [];
  for (const r of rows) {
    const liveRealized = Number(r.live_realized), lastPaid = Number(r.last_paid);
    if (Math.abs(liveRealized - lastPaid) <= TOL) continue;   // already right — idempotent skip
    const sns = await snsFor(r.product_id ? String(r.product_id) : null);
    const factor = 1 - sns / 100;

    let reason: Target["reason"];
    if (liveRealized > lastPaid) {
      reason = "overcharge";                                   // the swap reset — the main case
    } else if (CANARY_UNDERCHARGED.has(String(r.shopify_contract_id))) {
      reason = "undercharge";                                  // one of the 5 the first canary set low
    } else {
      continue;                                                // billing below their renewal rate for some other
    }                                                          // reason — never raise a customer to "fix" that

    targets.push({
      contractId: String(r.shopify_contract_id), subId: String(r.sub_id), internal: !!r.internal,
      email: String(r.email), variantId: String(r.variant_id),
      productId: r.product_id ? String(r.product_id) : null,
      liveRealized, lastPaid, writeBase: Math.round(lastPaid / factor), reason,
      lastOrder: r.last_order_at ? String(r.last_order_at).slice(0, 10) : null,
    });
  }

  const over = targets.filter(t => t.reason === "overcharge");
  const under = targets.filter(t => t.reason === "undercharge");
  const delta = over.reduce((s, t) => s + (t.liveRealized - t.lastPaid), 0);
  console.log(`\nsubs to correct: ${targets.length}   (overcharged ${over.length} · undercharged ${under.length})`);
  console.log(`per-cycle, per-unit overcharge being undone: $${(delta / 100).toFixed(2)}`);
  console.log(`internal rail: ${targets.filter(t => t.internal).length}`);
  console.log("\nworst overcharged:");
  for (const t of [...over].sort((a, b) => (b.liveRealized - b.lastPaid) - (a.liveRealized - a.lastPaid)).slice(0, 6))
    console.log(`  ${t.email.padEnd(32)} bills $${(t.liveRealized / 100).toFixed(2)} → $${(t.lastPaid / 100).toFixed(2)}  (write base $${(t.writeBase / 100).toFixed(2)}, last order ${t.lastOrder})`);
  if (under.length) {
    console.log("\nundercharged by the first canary run (raising back to their own last-paid):");
    for (const t of under)
      console.log(`  ${t.email.padEnd(32)} bills $${(t.liveRealized / 100).toFixed(2)} → $${(t.lastPaid / 100).toFixed(2)}  (write base $${(t.writeBase / 100).toFixed(2)})`);
  }

  const slice = targets.slice(0, LIMIT === Infinity ? targets.length : LIMIT);
  if (!APPLY) { console.log(`\nDRY RUN — would correct ${slice.length}. Re-run with --apply.`); return; }

  console.log(`\naudit log → ${LOG_PATH}\nconcurrency: ${CONCURRENCY}\n`);
  logLine({ event: "run_start", planned: slice.length, total: targets.length, over: over.length, under: under.length });

  const { subscriptionUpdateLineItemPrice, subscriptionGetLiveContract } = await import("../src/lib/commerce/subscription");
  let ok = 0, bad = 0; const failures: { email: string; error: string }[] = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= slice.length) return;
      const t = slice[i];
      try {
        const r = await subscriptionUpdateLineItemPrice(W, t.contractId, t.variantId, t.writeBase);
        if (!r.success) { logLine({ event: "price", ...t, ok: false, error: r.error }); failures.push({ email: t.email, error: r.error ?? "failed" }); bad++; continue; }

        // VERIFY-AFTER in REALIZED terms — a 2xx does not mean the contract changed.
        const live: any = await subscriptionGetLiveContract(W, t.contractId);
        const lines = live?.lines?.edges?.map((e: any) => e.node) || live?.lines?.nodes || [];
        const match = lines.find((l: any) => String(l?.variantId ?? "").includes(t.variantId) || String(l?.variant_id ?? "") === t.variantId);
        const nowRealized = match ? Math.round(Number(match.currentPrice?.amount ?? match.price ?? 0) * 100) : null;
        const verified = nowRealized != null && Math.abs(nowRealized - t.lastPaid) <= TOL;
        logLine({ event: "price", ...t, ok: true, verified, nowRealized });
        if (verified) ok++;
        else { bad++; failures.push({ email: t.email, error: `wrote base $${(t.writeBase / 100).toFixed(2)} but live bills ${nowRealized == null ? "unreadable" : "$" + (nowRealized / 100).toFixed(2)} (wanted $${(t.lastPaid / 100).toFixed(2)})` }); }
        if ((ok + bad) % 25 === 0) console.log(`  … ${ok + bad}/${slice.length}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logLine({ event: "threw", ...t, error: msg });
        failures.push({ email: t.email, error: msg }); bad++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, () => worker()));

  console.log(`\n✓ verified billing their last-paid price: ${ok}/${slice.length}`);
  if (failures.length) {
    console.log(`✗ ${failures.length} need attention:`);
    for (const f of failures.slice(0, 12)) console.log(`   ${f.email}: ${String(f.error).slice(0, 120)}`);
  }
  console.log(`audit log: ${LOG_PATH}`);
  logLine({ event: "run_end", verified: ok, failed: failures.length });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
