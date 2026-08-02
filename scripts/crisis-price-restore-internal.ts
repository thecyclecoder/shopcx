/**
 * crisis-price-restore-internal — the internal rail of the crisis price reset.
 *
 * `crisis-price-restore.ts` printed "internal rail: 0" on every run. That was a COVERAGE GAP, not a
 * clean bill: its detection reads `subscriptions.items[].price_cents`, and an internal sub's items
 * carry no such field — the price is computed at renewal by the pricing engine from
 * `price_override_cents` (a base) or `price_cents` (a verbatim charge), else live catalog
 * ([[../docs/brain/libraries/pricing]]). So all 21 internal subs in the crisis set were invisible to
 * it. Two of them had already renewed at the reset price by the time this was found
 * (carrie.allen@medtronic.com $38.95→$52.77, r.aycock@comcast.net $44.95→$59.96).
 *
 * The swap dropped their grandfather lock: every one of the 21 now has NO `price_override_cents` and
 * NO `price_cents`, which is the "live catalog opt-in" — so each renews at full standard price even
 * though their own history shows $38.95–$55.17.
 *
 * ── WHY THIS SOLVES FOR THE BASE INSTEAD OF COMPUTING IT ──────────────────────────────────────
 * `internalSubUpdateLineItemPrice` stores the override as a BASE and the engine applies the
 * quantity break AND S&S on top (src/lib/internal-subscription.ts:443). The Appstle-side formula
 * `base = realized / (1 − sns)` accounts for S&S only, so on a qty-break line it would land the
 * customer BELOW their rate — the same class of error as the first canary run, which is exactly
 * what this whole exercise is cleaning up.
 *
 * Rather than re-derive the engine's arithmetic (breaks, offers, per-product S&S) and get it subtly
 * wrong, this asks the engine itself: `resolveSubscriptionPricing` is pure with respect to the sub
 * object passed in, so a what-if call with a probe override reveals the true base→unit multiplier
 * for THAT line, and the base is solved from it. Nothing is written until the what-if confirms the
 * computed `unit_cents` equals the target to the cent.
 *
 * Target = the per-unit price that subscription last actually billed BEFORE the swap.
 *
 *   npx tsx scripts/crisis-price-restore-internal.ts            # dry run
 *   npx tsx scripts/crisis-price-restore-internal.ts --apply
 */
import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const SWAP_AT = "2026-07-30T00:00:00Z";
const TOL = 2;

interface Cand {
  email: string; subId: string; contractId: string; variantId: string;
  target: number; currentUnit: number; solvedBase: number | null; qty: number; note: string;
}

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");
  const c = pgClient(); await c.connect();
  let rows: any[] = [];
  try {
    rows = (await c.query(`
      select distinct on (s.id) cu.email, s.id sub_id, s.shopify_contract_id, s.items, s.pricing_offer_id,
        (select (i2->>'price_cents')::int from orders o2 cross join lateral jsonb_array_elements(o2.line_items) i2
          where o2.subscription_id = s.id and o2.created_at < $2
            and coalesce(o2.source_name,'') <> 'shopify_draft_order'
            and i2->>'sku' like 'SC-TABS%' and (i2->>'price_cents')::int > 0
          order by o2.created_at desc limit 1) pre_swap_unit
      from crisis_customer_actions a
      join subscriptions s on s.id = a.subscription_id and s.status in ('active','paused')
      join customers cu on cu.id = a.customer_id
      where s.workspace_id = $1 and a.restored_at is not null and coalesce(s.is_internal,false) = true
      order by s.id`, [W, SWAP_AT])).rows;
  } finally { await c.end(); }

  const { resolveSubscriptionPricing } = await import("../src/lib/pricing");
  const cands: Cand[] = [];

  for (const r of rows) {
    const target = r.pre_swap_unit == null ? null : Number(r.pre_swap_unit);
    const items = (r.items || []) as any[];
    const idx = items.findIndex(i => String(i.sku || "").startsWith("SC-TABS"));
    if (idx < 0) continue;
    const item = items[idx];
    const base: Cand = {
      email: String(r.email), subId: String(r.sub_id), contractId: String(r.shopify_contract_id),
      variantId: String(item.variant_id), target: target ?? 0, currentUnit: 0, solvedBase: null,
      qty: Number(item.quantity || 1), note: "",
    };

    // What the sub bills TODAY, per the engine.
    const now = await resolveSubscriptionPricing(W, { items, pricing_offer_id: r.pricing_offer_id });
    const line = (now.lines || []).find((l: any) => String(l.variant_id) === String(item.variant_id) && !l.is_gift);
    base.currentUnit = Number(line?.unit_cents ?? 0);

    if (target == null) { base.note = "no pre-swap renewal — no established rate, left alone"; cands.push(base); continue; }
    if (base.currentUnit <= target + TOL) { base.note = "already at or below its established rate"; cands.push(base); continue; }

    // Solve the base by asking the engine what a probe override produces on THIS line.
    const probe = items.map((it, k) => k === idx ? { ...it, price_override_cents: target, price_cents: undefined } : it);
    const p = await resolveSubscriptionPricing(W, { items: probe, pricing_offer_id: r.pricing_offer_id });
    const pl = (p.lines || []).find((l: any) => String(l.variant_id) === String(item.variant_id) && !l.is_gift);
    const probeUnit = Number(pl?.unit_cents ?? 0);
    if (!probeUnit) { base.note = "⚠️ engine returned no unit price for the probe — skipped"; cands.push(base); continue; }

    const solved = Math.round(target * target / probeUnit); // target / (probeUnit/target)
    const verify = items.map((it, k) => k === idx ? { ...it, price_override_cents: solved, price_cents: undefined } : it);
    const v = await resolveSubscriptionPricing(W, { items: verify, pricing_offer_id: r.pricing_offer_id });
    const vl = (v.lines || []).find((l: any) => String(l.variant_id) === String(item.variant_id) && !l.is_gift);
    const vUnit = Number(vl?.unit_cents ?? 0);
    if (Math.abs(vUnit - target) > TOL) { base.note = `⚠️ solved base $${(solved / 100).toFixed(2)} still prices at $${(vUnit / 100).toFixed(2)} — skipped`; cands.push(base); continue; }

    base.solvedBase = solved;
    base.note = `restore → base $${(solved / 100).toFixed(2)} prices at $${(vUnit / 100).toFixed(2)}`;
    cands.push(base);
  }

  const todo = cands.filter(x => x.solvedBase != null);
  console.log(`\ninternal crisis-restored subs: ${cands.length}`);
  console.log(`to restore: ${todo.length}\n`);
  for (const x of cands) {
    console.log(`  ${x.email.padEnd(32)} bills $${(x.currentUnit / 100).toFixed(2)} · established $${(x.target / 100).toFixed(2)} ×${x.qty} — ${x.note}`);
  }
  const delta = todo.reduce((s, x) => s + (x.currentUnit - x.target) * x.qty, 0);
  console.log(`\nper-cycle overcharge being undone: $${(delta / 100).toFixed(2)}`);

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply."); return; }

  const { subscriptionUpdateLineItemPrice } = await import("../src/lib/commerce/subscription");
  const admin = (await import("../src/lib/supabase/admin")).createAdminClient() as any;
  let ok = 0; const bad: string[] = [];
  for (const x of todo) {
    const r = await subscriptionUpdateLineItemPrice(W, x.contractId, x.variantId, x.solvedBase!);
    if (!r.success) { bad.push(`${x.email}: ${r.error}`); continue; }
    // VERIFY against the stored row + the engine, not the return value.
    const { data: after } = await admin.from("subscriptions").select("items, pricing_offer_id").eq("id", x.subId).maybeSingle();
    const priced = await resolveSubscriptionPricing(W, { items: after?.items, pricing_offer_id: after?.pricing_offer_id });
    const l = (priced.lines || []).find((y: any) => String(y.variant_id) === String(x.variantId) && !y.is_gift);
    const unit = Number(l?.unit_cents ?? 0);
    if (Math.abs(unit - x.target) <= TOL) { ok++; console.log(`  ✓ ${x.email.padEnd(32)} now prices at $${(unit / 100).toFixed(2)}`); }
    else bad.push(`${x.email}: wrote base $${(x.solvedBase! / 100).toFixed(2)} but engine prices $${(unit / 100).toFixed(2)} (wanted $${(x.target / 100).toFixed(2)})`);
  }
  console.log(`\n✓ restored ${ok}/${todo.length}`);
  if (bad.length) { console.log("✗ needs attention:"); for (const b of bad) console.log(`   ${b}`); }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
