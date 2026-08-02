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
 *   4. swap_stay_paused — paused for a NON-crisis reason but stranded on the substitute → swap the
 *                         flavour back, leave the pause ALONE (their pause, their call). Without
 *                         this they silently resume onto the substitute whenever they return.
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
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// Durable per-switch audit log. One JSONL line per ATTEMPTED mutation (ok and failed), written
// immediately so a crash mid-run still leaves a complete record of what was touched. Lives outside
// the repo checkout on purpose — that working tree is churned by the deploy guardian and an
// untracked file there has already been deleted mid-session once.
const LOG_PATH = process.env.CRISIS_RESTORE_LOG
  || `/private/tmp/claude-501/-Users-admin-Projects-shopcx/219f28b6-db60-4a01-a85f-78b760e5cc02/scratchpad/crisis-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
function logLine(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* logging must never break the run */ }
}

const TABS_SKU_PREFIX = "SC-TABS";
// Each row targets a DIFFERENT contract, so there is no shared state to race on — the only
// cross-row writes are the append-only audit log and a per-row DB stamp. Serial execution was
// measured at 6.9s/row (Appstle round-trip), i.e. ~96 min for 834 rows. A bounded pool cuts that
// proportionally. Kept modest by default so we don't trip Appstle rate limits; a 429 just fails
// that row, which stays un-restored and is picked up by the next run.
const CONCURRENCY = (() => {
  const i = process.argv.indexOf("--concurrency");
  return i > -1 ? Math.max(1, Math.min(12, Number(process.argv[i + 1]))) : 6;
})();
const APPLY = process.argv.includes("--apply");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i > -1 ? Math.max(1, Number(process.argv[i + 1])) : Infinity;
})();

type Branch = "swap_back" | "swap_then_resume" | "resume_only" | "readd" | "swap_stay_paused"
  | "swap_cancelled" | "swap_third_flavour" | "readd_then_resume";
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
    // CANCELLED (CEO 2026-07-29): still put the flavour right, so a reactivation comes back on Mixed
    // Berry rather than the substitute. Verified live that Appstle ACCEPTS a line-item swap on a
    // cancelled contract (test on 27844116653: Strawberry Lemonade×1 → Mixed Berry×1, success).
    // We swap ONLY — never resume; a cancelled sub stays cancelled, that is the customer's decision.
    if (sub.status === "cancelled") {
      const items0 = (sub.items || []) as { variant_id?: string | number; quantity?: number; sku?: string }[];
      if (items0.some(i => matches(i, AFF))) { skip("cancelled, already on the affected variant"); continue; }
      const sl = items0.find(i => matches(i, SWP));
      if (!sl) { skip("cancelled, not on the substitute — left alone"); continue; }
      plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
        branch: "swap_cancelled", fromVariant: SWAP, toVariant: AFFECTED, qty: Math.max(1, Number(sl.quantity ?? 1)) });
      continue;
    }

    const items = (sub.items || []) as { variant_id?: string | number; quantity?: number; sku?: string }[];
    const hasAffected = items.some(i => matches(i, AFF));
    const swapLine = items.find(i => matches(i, SWP));
    const chose = r.tier1_response === "accepted_swap" || r.tier2_response === "accepted_swap";

    // Branch 3 — item was removed, put it back.
    //
    // Two traps found by the canary on 27813085357 (berry_only, tier3=accepted_pause):
    //  (a) a row can carry BOTH removed_item+auto_readd AND paused+auto_resume. Returning after the
    //      re-add left the sub PAUSED — the customer accepted a pause on our promise to restart it,
    //      and we silently didn't. So the resume is folded in below, never skipped.
    //  (b) if the crisis ALSO auto-swapped a substitute line onto the sub, a blind add leaves them
    //      holding BOTH flavours and billed for double. When a substitute line is present we SWAP it
    //      instead of adding — same restoration, no duplicate.
    if (r.removed_item_at && r.auto_readd) {
      const v = r.original_item?.variant_id ? String(r.original_item.variant_id) : null;
      if (!v) { skip("removed row has no original variant_id — cannot re-add"); continue; }
      const alsoResumes = sub.status === "paused" && !!r.paused_at && r.auto_resume === true;
      if (hasAffected) {
        // Already restored. Still owe them the resume if one was promised.
        if (alsoResumes) {
          plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
            branch: "resume_only", toVariant: AFFECTED, qty: 1 });
        } else { skip("already holds the affected variant"); }
        continue;
      }
      if (swapLine) {
        plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
          branch: alsoResumes ? "swap_then_resume" : "swap_back",
          fromVariant: SWAP, toVariant: AFFECTED, qty: Math.max(1, Number(swapLine.quantity ?? 1)) });
        continue;
      }
      plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
        branch: alsoResumes ? "readd_then_resume" : "readd",
        toVariant: v, qty: Math.max(1, Number(r.original_item?.quantity ?? 1)) });
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
    // Paused for a NON-crisis reason (customer, dunning, portal) — we must NOT unpause them, that
    // is their decision. But if the crisis silently swapped them onto the substitute, leaving it
    // there means they resume onto the WRONG FLAVOUR whenever they come back. Swap the flavour,
    // leave the pause alone. (80 of these on the live crisis — they were invisible in the first
    // cut of this script, which skipped the whole bucket.)
    if (sub.status === "paused") {
      if (hasAffected) { skip("paused (non-crisis) and already on the affected variant"); continue; }
      if (!swapLine) { skip("paused (non-crisis), holds neither variant — left alone"); continue; }
      plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
        branch: "swap_stay_paused", fromVariant: SWAP, toVariant: AFFECTED, qty: Math.max(1, Number(swapLine.quantity ?? 1)) });
      continue;
    }

    // Branch 1 — active, still on the substitute.
    //
    // CEO 2026-07-29: swap back EVERYONE holding the substitute, including the handful who actively
    // chose it at Tier 1/2. Rationale is theirs to make — they chose Strawberry Lemonade while Mixed
    // Berry was unavailable, which is a constrained choice, not a preference. Customers who picked a
    // THIRD flavour are still left alone: they aren't on the swap variant, so they never reach here.
    if (hasAffected) { skip("already back on the affected variant"); continue; }
    if (!swapLine) {
      // THIRD FLAVOUR (CEO 2026-07-29): they picked a different Superfood Tabs flavour (mostly Peach
      // Mango) at Tier 1 — bring them back to Mixed Berry too. Two hazards are guarded out: a sub
      // that took a Tier 2 PRODUCT swap has no tabs line at all (nothing to swap back), and a sub
      // with MORE THAN ONE tabs line is ambiguous about which line to move — that needs a human.
      const tabsLines = items.filter(i => String(i.sku ?? "").startsWith(TABS_SKU_PREFIX));
      if (tabsLines.length === 0) { skip("took a product swap — no tabs line to restore"); continue; }
      // A sub holding the SUBSTITUTE alongside another flavour never reaches here — `swapLine` is
      // truthy, so it goes down swap_back, which swaps ONLY the substitute line and leaves the other
      // flavour untouched. That is the CEO's rule (2026-07-29: "swap the strawberry lemonade for
      // mixed berry, and leave peach mango alone") and it already holds by construction.
      // What DOES land here is >1 tabs line with no substitute among them. On the live crisis both
      // such subs are DUPLICATE Peach Mango lines (same sku + same variant_id, ×1 each) — a chosen
      // flavour, so leave them alone. Distinct flavours would be a genuine judgement call.
      if (tabsLines.length > 1) {
        const distinct = new Set(tabsLines.map(i => String(i.variant_id)));
        skip(distinct.size === 1
          ? "duplicate lines of a flavour they chose — left alone"
          : "several different chosen flavours, no substitute — needs a human");
        continue;
      }
      const line = tabsLines[0];
      plans.push({ rowId: r.id, contractId: sub.shopify_contract_id, subId: sub.id, internal: !!sub.is_internal,
        branch: "swap_third_flavour", fromVariant: String(line.variant_id), toVariant: AFFECTED,
        qty: Math.max(1, Number(line.quantity ?? 1)) });
      continue;
    }
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
  console.log(`\naudit log → ${LOG_PATH}`);
  console.log(`concurrency: ${CONCURRENCY}\n`);
  logLine({ event: "run_start", crisis: crisis.id, planned: slice.length, total_plan: plans.length,
            affected: AFFECTED, swap: SWAP, limit: LIMIT === Infinity ? null : LIMIT });
  const { subscriptionSwapVariant, subscriptionAddItem, subscriptionAction } =
    await import("../src/lib/commerce/subscription");
  let ok = 0; const failures: { rowId: string; branch: string; error: string }[] = [];

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= slice.length) return;
      const p = slice[idx];
    try {
      // Rail-correct ids: the internal rail addresses variants by UUID, Appstle by Shopify id.
      const from = p.branch === "swap_third_flavour"
        ? p.fromVariant!                                   // already this sub's own line id, on its own rail
        : (p.internal ? (SWP.uuid ?? p.fromVariant!) : p.fromVariant!);
      const to = p.internal ? (AFF.uuid ?? p.toVariant) : p.toVariant;
      if (p.branch === "swap_back" || p.branch === "swap_then_resume" || p.branch === "swap_stay_paused"
          || p.branch === "swap_cancelled" || p.branch === "swap_third_flavour") {
        const r = await subscriptionSwapVariant(crisis.workspace_id, p.contractId, from, to, p.qty);
        logLine({ event: "swap", rowId: p.rowId, contract: p.contractId, internal: p.internal, branch: p.branch,
                  from, to, qty: p.qty, ok: r.success, error: r.error ?? null });
        if (!r.success) { failures.push({ rowId: p.rowId, branch: p.branch, error: `swap: ${r.error}` }); continue; }
      }
      if (p.branch === "readd" || p.branch === "readd_then_resume") {
        const r = await subscriptionAddItem(crisis.workspace_id, p.contractId, to, p.qty);
        logLine({ event: "readd", rowId: p.rowId, contract: p.contractId, internal: p.internal, branch: p.branch,
                  variant: to, qty: p.qty, ok: r.success, error: r.error ?? null });
        if (!r.success) { failures.push({ rowId: p.rowId, branch: p.branch, error: `readd: ${r.error}` }); continue; }
      }
      // Resume LAST — only after the flavour is correct.
      if (p.branch === "swap_then_resume" || p.branch === "resume_only" || p.branch === "readd_then_resume") {
        const r = await subscriptionAction(crisis.workspace_id, p.contractId, "resume",
          undefined, "crisis-restore: affected variant back in stock");
        logLine({ event: "resume", rowId: p.rowId, contract: p.contractId, internal: p.internal, branch: p.branch,
                  ok: r.success, error: r.error ?? null });
        if (!r.success) { failures.push({ rowId: p.rowId, branch: p.branch, error: `resume: ${r.error}` }); continue; }
      }
      await admin.from("crisis_customer_actions")
        .update({ restored_at: new Date().toISOString(), restore_action: p.branch, updated_at: new Date().toISOString() })
        .eq("id", p.rowId).is("restored_at", null); // compare-and-set
      logLine({ event: "row_done", rowId: p.rowId, contract: p.contractId, branch: p.branch });
      ok++;
      if (ok % 25 === 0) console.log(`  … ${ok}/${slice.length}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logLine({ event: "threw", rowId: p.rowId, contract: p.contractId, branch: p.branch, error: msg });
      failures.push({ rowId: p.rowId, branch: p.branch, error: msg });
    }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, () => worker()));

  logLine({ event: "run_end", restored: ok, attempted: slice.length, failed: failures.length });
  console.log(`\n✓ restored ${ok}/${slice.length}`);
  console.log(`audit log: ${LOG_PATH}`);
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
