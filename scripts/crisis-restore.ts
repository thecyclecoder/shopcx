/**
 * crisis-restore — put every crisis-affected subscription back on the affected variant once it is
 * BACK IN STOCK, then archive the crisis row.
 *
 * The crisis system's Phase 6 only ever resumed paused subs and re-added removed items — 67 of 949
 * rows. The ~459 subscriptions that were SILENTLY auto-swapped to the substitute flavour were never
 * put back, and nobody was ever told the crisis ended. This is that missing action.
 *
 * Three branches, per the CEO's instruction (2026-07-29):
 *   1. swap_back        — active sub still holding the swap variant → swap back to the affected one
 *   2. swap_then_resume — paused w/ auto_resume → swap back FIRST, then resume (order matters: never
 *                         resume a sub onto the wrong flavour, it would bill + ship the substitute)
 *   3. readd            — item was removed w/ auto_readd → add the affected variant back
 *
 * DISCIPLINE
 * - Guard-first. Every mutation re-reads LIVE subscription state and re-confirms the predicate; the
 *   row's stored flags are a hint, never the authority. (10 rows carry a stale `cancelled` flag —
 *   flagged cancelled while the sub is actually active — so trusting flags would mutate the wrong subs.)
 * - Idempotent. A restored row is stamped `restored_at` and skipped forever after. Safe to re-run,
 *   safe to batch with --limit, safe to resume after a mid-run failure.
 * - Never abort the batch on one failure. Per-row errors are collected and reported.
 *   CEO 2026-07-29 override: swap back EVERYONE on the substitute, chosen or not — choosing it while
 *   Mixed Berry was unavailable is a constrained choice. A third flavour is still left alone.
 *
 * TIMING (CEO 2026-07-29). Run this BEFORE the storefront shows Mixed Berry in stock. The inventory
 * is arriving at the warehouse now and will read out-of-stock for a few more days, but these are
 * SUBSCRIPTIONS — what matters is that stock exists by the time each contract renews, not that the
 * PDP says "in stock" today. Waiting has a real cost in the other direction: Strawberry Lemonade is
 * down to ~63 units, and every day 467 subscriptions stay swapped onto it is another day draining
 * the substitute. Moving them back to Mixed Berry is what protects that remaining SL inventory.
 *
 *   npx tsx scripts/crisis-restore.ts                    # dry run, full plan
 *   npx tsx scripts/crisis-restore.ts --limit 10         # dry run, canary slice
 *   npx tsx scripts/crisis-restore.ts --apply --limit 10 # canary for real
 *   npx tsx scripts/crisis-restore.ts --apply           # the rest
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const APPLY = process.argv.includes("--apply");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i > -1 ? Math.max(1, Number(process.argv[i + 1])) : Infinity;
})();

type Branch = "swap_back" | "swap_then_resume" | "resume_only" | "readd";
interface Plan {
  rowId: string; contractId: string; subId: string; branch: Branch; internal: boolean;
  fromVariant?: string; toVariant: string; qty: number;
}

async function main() {
  const admin = createAdminClient() as any;
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { data: crisis } = await admin.from("crisis_events")
    .select("id, name, workspace_id, status, affected_variant_id, default_swap_variant_id")
    .eq("status", "active").maybeSingle();
  if (!crisis) { console.log("no active crisis — nothing to do"); return; }
  const AFFECTED = String(crisis.affected_variant_id);
  const SWAP = String(crisis.default_swap_variant_id);

  // A crisis is configured with SHOPIFY variant ids, but an in-house subscription stores ShopCX
  // UUID variant ids on its `items` — so a Shopify-id match finds NOTHING on the internal rail
  // (verified: all 28 internal crisis subs matched neither variant). Resolve both variants to their
  // dual identity up front and carry it through matching AND mutation: Appstle takes the numeric
  // Shopify id, the internal rail takes the UUID. The SKU is the stable join across both.
  const { data: vrows } = await admin.from("product_variants")
    .select("id, shopify_variant_id, sku, title")
    .eq("workspace_id", crisis.workspace_id)
    .in("shopify_variant_id", [AFFECTED, SWAP]);
  const ident = (shopifyId: string) => {
    const v = (vrows || []).find((x: any) => String(x.shopify_variant_id) === shopifyId);
    return { shopify: shopifyId, uuid: v?.id ? String(v.id) : null, sku: v?.sku ? String(v.sku) : null };
  };
  const AFF = ident(AFFECTED), SWP = ident(SWAP);
  console.log(`crisis: "${crisis.name}"`);
  console.log(`  restore  ${SWP.sku ?? SWAP} → ${AFF.sku ?? AFFECTED}`);
  console.log(`  appstle  ${SWAP} → ${AFFECTED}`);
  console.log(`  internal ${SWP.uuid ?? "(unmapped)"} → ${AFF.uuid ?? "(unmapped)"}\n`);
  if (!AFF.uuid || !SWP.uuid) {
    console.log("WARNING: a variant has no product_variants row — internal-rail subs cannot be matched or mutated.");
  }

  /** Match an item on EITHER rail: Shopify id, internal UUID, or SKU. */
  const matches = (it: { variant_id?: string | number; sku?: string }, v: ReturnType<typeof ident>) => {
    const id = String(it.variant_id ?? "");
    return id === v.shopify || (!!v.uuid && id === v.uuid) || (!!v.sku && String(it.sku ?? "") === v.sku);
  };

  const { data: rows } = await admin.from("crisis_customer_actions")
    .select("id, subscription_id, segment, cancelled, paused_at, auto_resume, removed_item_at, auto_readd, original_item, tier1_response, tier2_response, restored_at")
    .eq("crisis_id", crisis.id).eq("workspace_id", crisis.workspace_id)
    .is("restored_at", null);
  console.log(`un-restored rows: ${rows?.length ?? 0}`);

  const plans: Plan[] = [];
  const skips: Record<string, number> = {};
  let tierChosenIncluded = 0;
  const skip = (why: string) => { skips[why] = (skips[why] || 0) + 1; };

  for (const r of rows || []) {
    if (!r.subscription_id) { skip("no subscription_id"); continue; }
    // LIVE state — never trust the row's flags alone.
    const { data: sub } = await admin.from("subscriptions")
      .select("id, shopify_contract_id, status, items, is_internal")
      .eq("id", r.subscription_id).eq("workspace_id", crisis.workspace_id).maybeSingle();
    if (!sub?.shopify_contract_id) { skip("no live subscription row"); continue; }
    if (sub.status === "cancelled") { skip("subscription cancelled"); continue; }

    const items = (sub.items || []) as { variant_id?: string | number; quantity?: number; sku?: string }[];
    const hasAffected = items.some(i => matches(i, AFF));
    const swapLine = items.find(i => matches(i, SWP));
    const chose = r.tier1_response === "accepted_swap" || r.tier2_response === "accepted_swap";

    // Branch 3 — item was removed, add it back.
    if (r.removed_item_at && r.auto_readd) {
      const v = r.original_item?.variant_id ? String(r.original_item.variant_id) : null;
      if (!v) { skip("removed row has no original variant_id — cannot re-add"); continue; }
      if (hasAffected) { skip("already holds the affected variant"); continue; }
      plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
        branch: "readd", toVariant: v, qty: Math.max(1, Number(r.original_item?.quantity ?? 1)) });
      continue;
    }

    // Branch 2 — paused with auto_resume. Swap back FIRST (if needed), then resume.
    if (sub.status === "paused" && r.paused_at && r.auto_resume) {
      if (hasAffected) {
        plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal, branch: "resume_only", toVariant: AFFECTED, qty: 1 });
      } else if (swapLine) {
        plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
          branch: "swap_then_resume", fromVariant: SWAP, toVariant: AFFECTED, qty: Math.max(1, Number(swapLine.quantity ?? 1)) });
      } else {
        skip("paused but holds neither the affected nor the swap variant — needs a human");
      }
      continue;
    }
    if (sub.status === "paused") { skip("paused for a non-crisis reason — left alone"); continue; }

    // Branch 1 — active, still on the substitute.
    //
    // CEO 2026-07-29: swap back EVERYONE holding the substitute, including the handful who actively
    // chose it at Tier 1/2. Rationale is theirs to make — they chose Strawberry Lemonade while Mixed
    // Berry was unavailable, which is a constrained choice, not a preference. Customers who picked a
    // THIRD flavour are still left alone: they aren't on the swap variant, so they never reach here.
    if (hasAffected) { skip("already back on the affected variant"); continue; }
    if (!swapLine) { skip("active but not on the swap variant (chose another flavour)"); continue; }
    if (chose) tierChosenIncluded++;
    plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
      branch: "swap_back", fromVariant: SWAP, toVariant: AFFECTED, qty: Math.max(1, Number(swapLine.quantity ?? 1)) });
  }

  const byBranch: Record<string, number> = {};
  for (const p of plans) byBranch[p.branch] = (byBranch[p.branch] || 0) + 1;
  console.log("\nPLAN:");
  for (const [k, v] of Object.entries(byBranch)) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(`  ${String(plans.length).padStart(4)}  TOTAL to mutate`);
  const internalCount = plans.filter(p => p.internal).length;
  console.log(`        rail: ${plans.length - internalCount} Appstle · ${internalCount} internal (Commerce SDK dispatches both)`);
  if (tierChosenIncluded) console.log(`        includes ${tierChosenIncluded} who chose the substitute at Tier 1/2 (CEO: swap them back too)`);
  console.log("\nSKIPPED:");
  for (const [k, v] of Object.entries(skips).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

  const slice = plans.slice(0, LIMIT === Infinity ? plans.length : LIMIT);
  if (!APPLY) {
    console.log(`\nDRY RUN — would mutate ${slice.length}${LIMIT !== Infinity ? ` (--limit ${LIMIT})` : ""}.`);
    console.log("Re-run with --apply.");
    return;
  }

  // COMMERCE SDK ONLY. `subscriptionAction` / `subscriptionSwapVariant` / `subscriptionAddItem`
  // dispatch internal-vs-Appstle for us (isInternalSubscription → internalSub* vs appstle*). Calling
  // `appstleSubscriptionAction` directly would send the 20 in-house subs in this batch down the
  // Appstle rail — a synthetic `internal-…` contract id that Appstle 400s on.
  const { subscriptionSwapVariant, subscriptionAddItem, subscriptionAction } =
    await import("../src/lib/commerce/subscription");
  let ok = 0; const failures: { rowId: string; branch: string; error: string }[] = [];

  for (const p of slice) {
    try {
      // Rail-correct ids: the internal rail addresses variants by UUID, Appstle by Shopify id.
      const from = p.internal ? (SWP.uuid ?? p.fromVariant!) : p.fromVariant!;
      const to = p.internal ? (AFF.uuid ?? p.toVariant) : p.toVariant;
      if (p.branch === "swap_back" || p.branch === "swap_then_resume") {
        const r = await subscriptionSwapVariant(crisis.workspace_id, p.contractId, from, to, p.qty);
        if (!r.success) { failures.push({ rowId: p.rowId, branch: p.branch, error: `swap: ${r.error}` }); continue; }
      }
      if (p.branch === "readd") {
        const r = await subscriptionAddItem(crisis.workspace_id, p.contractId, to, p.qty);
        if (!r.success) { failures.push({ rowId: p.rowId, branch: p.branch, error: `readd: ${r.error}` }); continue; }
      }
      // Resume LAST — only after the flavour is correct.
      if (p.branch === "swap_then_resume" || p.branch === "resume_only") {
        const r = await subscriptionAction(crisis.workspace_id, p.contractId, "resume",
          undefined, "crisis-restore: affected variant back in stock");
        if (!r.success) { failures.push({ rowId: p.rowId, branch: p.branch, error: `resume: ${r.error}` }); continue; }
      }
      await admin.from("crisis_customer_actions")
        .update({ restored_at: new Date().toISOString(), restore_action: p.branch, updated_at: new Date().toISOString() })
        .eq("id", p.rowId).is("restored_at", null); // compare-and-set
      ok++;
      if (ok % 25 === 0) console.log(`  … ${ok}/${slice.length}`);
    } catch (e) {
      failures.push({ rowId: p.rowId, branch: p.branch, error: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log(`\n✓ restored ${ok}/${slice.length}`);
  if (failures.length) {
    console.log(`✗ ${failures.length} failed (row stays un-restored — re-run picks it up):`);
    for (const f of failures.slice(0, 15)) console.log(`   ${f.rowId.slice(0, 8)} ${f.branch}: ${f.error}`);
  }
  const { count: left } = await admin.from("crisis_customer_actions")
    .select("id", { count: "exact", head: true })
    .eq("crisis_id", crisis.id).is("restored_at", null);
  console.log(`\nrows still un-restored: ${left}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
