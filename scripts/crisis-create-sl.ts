/**
 * crisis-create-sl — stand up the Strawberry Lemonade out-of-stock crisis and enrol + auto-swap
 * every live subscription onto Mixed Berry, recording the SL line as `original_item` so the SAME
 * restore path (scripts/crisis-restore.ts) swaps them BACK when SL returns.
 *
 * CEO 2026-07-30: "find all subs still with strawberry lemonade, then auto-swap them to mixed
 * berry, then mark their record as a swapback to strawberry lemonade when it's back in stock."
 *
 * WHY original_item IS THE SWAP-BACK CONTRACT
 * `crisis_customer_actions.original_item` is what the restore reads to know what to put back. By
 * writing the customer's actual SL line there (variant, qty, sku, title) the reversal is already
 * expressed — when SL is in stock, `crisis-restore.ts` against this crisis swaps Mixed Berry → SL
 * for exactly these rows and stamps `restored_at`. No second mechanism needed.
 *
 * ORDERING CONSTRAINT
 * `crisis-restore.ts` resolves THE active crisis with `.eq("status","active").maybeSingle()`, so two
 * concurrently-active crises would make it ambiguous. The Mixed Berry crisis must be flipped off
 * `active` before this one goes active. This script refuses to activate while another crisis is
 * active rather than create that ambiguity silently.
 *
 *   npx tsx scripts/crisis-create-sl.ts                 # dry run — plan only
 *   npx tsx scripts/crisis-create-sl.ts --apply         # create crisis (draft) + enrol + swap
 *   npx tsx scripts/crisis-create-sl.ts --apply --activate --concurrency 4
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SL = { shopify: "42614433480877", uuid: "6ab0ddac-1ec4-491d-b399-340811747640", sku: "SC-TABS-SL-2", title: "Strawberry Lemonade" };
const MB = { shopify: "42614433448109", uuid: "1f2b296d-024c-4e5c-889b-c05d2f0ce7fe", sku: "SC-TABS-BERRY", title: "Mixed Berry" };
const PM = { shopify: "42614433513645", title: "Peach Mango" };
const RESTOCK = "2026-11-01";

const APPLY = process.argv.includes("--apply");
const ACTIVATE = process.argv.includes("--activate");
const INCLUDE_CANCELLED = process.argv.includes("--include-cancelled");
const CONCURRENCY = (() => { const i = process.argv.indexOf("--concurrency"); return i > -1 ? Math.max(1, Math.min(8, Number(process.argv[i + 1]))) : 4; })();
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i > -1 ? Math.max(1, Number(process.argv[i + 1])) : Infinity; })();

const LOG_PATH = process.env.CRISIS_SL_LOG
  || `/private/tmp/claude-501/-Users-admin-Projects-shopcx/219f28b6-db60-4a01-a85f-78b760e5cc02/scratchpad/crisis-sl-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
function logLine(e: Record<string, unknown>) {
  try { mkdirSync(dirname(LOG_PATH), { recursive: true }); appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n"); } catch {}
}

const holdsSL = (i: { variant_id?: string | number; sku?: string }) =>
  [SL.shopify, SL.uuid].includes(String(i.variant_id ?? "")) || String(i.sku ?? "") === SL.sku;
const holdsMB = (i: { variant_id?: string | number; sku?: string }) =>
  [MB.shopify, MB.uuid].includes(String(i.variant_id ?? "")) || String(i.sku ?? "") === MB.sku;

async function main() {
  const admin = createAdminClient() as any;
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { data: otherActive } = await admin.from("crisis_events")
    .select("id, name").eq("workspace_id", W).eq("status", "active");
  const blockers = (otherActive || []).filter((c: any) => !String(c.name).includes("Strawberry Lemonade"));
  if (blockers.length) {
    console.log(`\n⚠️  ${blockers.length} other crisis still ACTIVE: ${blockers.map((b: any) => `"${b.name}"`).join(", ")}`);
    console.log("   crisis-restore.ts resolves THE active crisis — two would be ambiguous.");
    if (ACTIVATE) { console.log("   REFUSING --activate until that one is resolved."); process.exit(1); }
    console.log("   (creating as draft is fine; activate after the other is resolved)");
  }

  // Every LIVE sub holding Strawberry Lemonade.
  const statuses = INCLUDE_CANCELLED ? ["active", "paused", "cancelled"] : ["active", "paused"];
  // PAGINATE. A bare .select() is capped by PostgREST at 1000 rows — this workspace has 3192
  // active/paused subs, so an unpaginated read found 118 of 429 SL holders and would have silently
  // left 311 subscriptions stranded on the out-of-stock flavour. Same blind-truncation class as the
  // escalation reconciler's .limit(5000) sample. Read every page, assert we got them all.
  const PAGE = 1000;
  const subs: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await admin.from("subscriptions")
      .select("id, customer_id, shopify_contract_id, status, items, is_internal, next_billing_date")
      .eq("workspace_id", W).in("status", statuses)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    subs.push(...(page || []));
    if (!page || page.length < PAGE) break;
  }
  const { count: expected } = await admin.from("subscriptions")
    .select("id", { count: "exact", head: true }).eq("workspace_id", W).in("status", statuses);
  console.log(`scanned ${subs.length} subscriptions (expected ${expected})`);
  if (expected != null && subs.length < expected) {
    console.log("REFUSING: pagination came up short — would enrol an incomplete set.");
    process.exit(1);
  }
  const targets = (subs || []).filter((s: any) => (s.items || []).some(holdsSL));
  console.log(`\nsubs holding Strawberry Lemonade (${statuses.join("/")}): ${targets.length}`);
  const alreadyMB = targets.filter((s: any) => (s.items || []).some(holdsMB)).length;
  console.log(`  of which ALSO already hold Mixed Berry: ${alreadyMB} (swap would merge two lines — skipped)`);
  console.log(`  internal rail: ${targets.filter((s: any) => s.is_internal).length}`);

  if (!APPLY) {
    console.log(`\nWould: create crisis "Out of Stock: Superfood Tabs Strawberry Lemonade" (restock ${RESTOCK})`);
    console.log(`       enrol + auto-swap ${targets.length - alreadyMB} subs SL → Mixed Berry`);
    console.log(`       original_item = their SL line, so crisis-restore.ts swaps them BACK when SL returns`);
    console.log("\nRe-run with --apply.");
    return;
  }

  // 1. Crisis row (draft unless --activate).
  const { data: existing } = await admin.from("crisis_events")
    .select("id, status").eq("workspace_id", W).eq("affected_variant_id", SL.shopify).maybeSingle();
  let crisisId = existing?.id as string | undefined;
  if (!crisisId) {
    const { data: created, error } = await admin.from("crisis_events").insert({
      workspace_id: W,
      name: "Out of Stock: Superfood Tabs Strawberry Lemonade",
      status: ACTIVATE ? "active" : "draft",
      affected_variant_id: SL.shopify, affected_sku: SL.sku,
      affected_product_title: `Superfood Tabs — ${SL.title}`,
      default_swap_variant_id: MB.shopify, default_swap_title: MB.title,
      available_flavor_swaps: [{ title: MB.title, variantId: MB.shopify }, { title: PM.title, variantId: PM.shopify }],
      available_product_swaps: [],
      tier2_coupon_percent: 20,
      expected_restock_date: RESTOCK,
      lead_time_days: 7, tier_wait_days: 3,
    }).select("id").single();
    if (error) throw error;
    crisisId = created.id;
    console.log(`\n✓ crisis created ${crisisId} [${ACTIVATE ? "active" : "draft"}]`);
  } else {
    console.log(`\n· reusing existing SL crisis ${crisisId} [${existing.status}]`);
  }
  logLine({ event: "crisis", crisisId, activate: ACTIVATE, restock: RESTOCK });

  // 2. Enrol + swap.
  const { subscriptionSwapVariant } = await import("../src/lib/commerce/subscription");
  const todo = targets.filter((s: any) => !(s.items || []).some(holdsMB)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`enrolling + swapping ${todo.length} subs · concurrency ${CONCURRENCY}`);
  console.log(`audit log → ${LOG_PATH}\n`);

  let ok = 0; const failures: { contract: string; error: string }[] = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= todo.length) return;
      const s = todo[idx];
      try {
        // Idempotency: skip a sub already enrolled in THIS crisis.
        const { data: prior } = await admin.from("crisis_customer_actions")
          .select("id").eq("crisis_id", crisisId).eq("subscription_id", s.id).maybeSingle();
        if (prior) { logLine({ event: "skip", contract: s.shopify_contract_id, why: "already enrolled" }); continue; }

        const line = (s.items || []).find(holdsSL);
        const qty = Math.max(1, Number(line?.quantity ?? 1));
        const realItems = (s.items || []).filter((i: any) => !String(i.sku ?? "").startsWith("insure") && Number(i.price_cents ?? 1) !== 0);
        const segment = realItems.length <= 1 ? "sl_only" : "sl_plus";

        // original_item = the SL line. THIS is the swap-back contract crisis-restore.ts reads.
        const originalItem = {
          sku: line?.sku ?? SL.sku, title: `Superfood Tabs`, variant_title: SL.title,
          quantity: qty, variant_id: s.is_internal ? SL.uuid : SL.shopify,
        };
        const { error: insErr } = await admin.from("crisis_customer_actions").insert({
          crisis_id: crisisId, workspace_id: W, subscription_id: s.id, customer_id: s.customer_id,
          segment, original_item: originalItem, current_tier: 1, tier1_sent_at: new Date().toISOString(),
        });
        if (insErr) { failures.push({ contract: s.shopify_contract_id, error: `enrol: ${insErr.message}` }); continue; }

        const from = s.is_internal ? SL.uuid : SL.shopify;
        const to = s.is_internal ? MB.uuid : MB.shopify;
        const r = await subscriptionSwapVariant(W, s.shopify_contract_id, from, to, qty);
        logLine({ event: "swap", contract: s.shopify_contract_id, internal: !!s.is_internal, segment, from, to, qty, ok: r.success, error: r.error ?? null });
        if (!r.success) { failures.push({ contract: s.shopify_contract_id, error: r.error ?? "swap failed" }); continue; }
        ok++;
        if (ok % 25 === 0) console.log(`  … ${ok}/${todo.length}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logLine({ event: "threw", contract: s.shopify_contract_id, error: msg });
        failures.push({ contract: s.shopify_contract_id, error: msg });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()));

  console.log(`\n✓ enrolled + swapped ${ok}/${todo.length}`);
  if (failures.length) {
    console.log(`✗ ${failures.length} failed (not enrolled — re-run picks them up):`);
    for (const f of failures.slice(0, 10)) console.log(`   ${f.contract}: ${String(f.error).slice(0, 120)}`);
  }
  console.log(`audit log: ${LOG_PATH}`);
  logLine({ event: "run_end", ok, attempted: todo.length, failed: failures.length });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
