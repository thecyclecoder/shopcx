/**
 * Run a MIGRATION WAVE: a bounded, deliberately-chosen set of real Appstle contracts moved to
 * ShopCX, sized so a human can still watch the result.
 *
 * ⭐ The wave is picked to EXERCISE what is untested, not to move volume. Every charge ShopCX has
 * ever fired succeeded, so the decline path has never run in production — which means the wave
 * wants subs that actually renew while we are watching (a few days out), spread across cadences,
 * including multi-line ones.
 *
 * Appstle is metered per call and each contract costs one fresh read, so the candidate SELECT is
 * local (snapshots + our mirror) and only the chosen few touch the vendor.
 *
 *   npx tsx scripts/_run-migration-wave.ts                          # candidate report, no calls
 *   npx tsx scripts/_run-migration-wave.ts --dry --size 25          # plan each, vendor reads only
 *   npx tsx scripts/_run-migration-wave.ts --apply --size 25        # migrate for real
 *   npx tsx scripts/_run-migration-wave.ts --apply --contract 12345 # one, by id
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRICING_RULE_ID = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19"; // Powder Drinks: Buy More, Save More

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const DRY = process.argv.includes("--dry");
const APPLY = process.argv.includes("--apply");
const SIZE = Number(arg("--size") ?? 25);
const ONE = arg("--contract");
const DUE_FROM_DAYS = Number(arg("--from") ?? 3);
const DUE_TO_DAYS = Number(arg("--to") ?? 10);
/** Exact calendar due date (UTC), e.g. --due 2026-09-19. Overrides the day window. */
const DUE_ON = arg("--due");

/** Politeness delay between contracts. Appstle is metered AND rate limited. */
const PACE_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

interface Cand {
  contractId: string;
  subId: string;
  due: string;
  cadence: string;
  lines: number;
  monthlyCents: number;
}

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { loadPricingContext, executeMigration } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();

  const ctx = await loadPricingContext(WORKSPACE_ID, PRICING_RULE_ID);
  console.log(`rule: S&S ${ctx.snsPct}%  breaks ${ctx.breaks.map((b) => `${b.quantity}:${b.discount_pct}%`).join(" ")}\n`);

  // ── candidates, entirely from local data ────────────────────────────────────
  const from = DUE_ON
    ? `${DUE_ON}T00:00:00.000Z`
    : new Date(Date.now() + DUE_FROM_DAYS * 86400000).toISOString();
  const to = DUE_ON
    ? `${DUE_ON}T23:59:59.999Z`
    : new Date(Date.now() + DUE_TO_DAYS * 86400000).toISOString();

  let q = admin.from("subscriptions")
    .select("id, shopify_contract_id, next_billing_date, billing_interval, billing_interval_count, items")
    .eq("workspace_id", WORKSPACE_ID).eq("status", "active").eq("billing_source", "appstle");
  if (ONE) q = q.eq("shopify_contract_id", ONE);
  else q = q.gte("next_billing_date", from).lte("next_billing_date", to);
  const { data: subs } = await q.order("next_billing_date").limit(1000);

  // A contract with no snapshot cannot be planned, and one already marked is already migrated.
  const ids = (subs ?? []).map((s) => s.shopify_contract_id);
  const snapOk = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("appstle_contract_snapshots")
      .select("appstle_contract_id, migrated_to_contract_id, fetch_error")
      .eq("workspace_id", WORKSPACE_ID).in("appstle_contract_id", ids.slice(i, i + 200));
    for (const r of data ?? []) {
      if (!r.migrated_to_contract_id && !r.fetch_error) snapOk.add(r.appstle_contract_id as string);
    }
  }

  const cands: Cand[] = [];
  for (const s of subs ?? []) {
    if (!snapOk.has(s.shopify_contract_id)) continue;
    const items = (s.items as { quantity?: number; price_cents?: number }[]) ?? [];
    const cycleCents = items.reduce((t, i) => t + (i.price_cents ?? 0) * (i.quantity ?? 1), 0);
    cands.push({
      contractId: s.shopify_contract_id,
      subId: s.id,
      due: String(s.next_billing_date).slice(0, 10),
      cadence: `${s.billing_interval}/${s.billing_interval_count}`,
      lines: items.length,
      monthlyCents: cycleCents,
    });
  }

  const byCadence: Record<string, Cand[]> = {};
  for (const c of cands) (byCadence[c.cadence] ??= []).push(c);
  console.log(`candidates due ${DUE_ON ?? `+${DUE_FROM_DAYS}d..+${DUE_TO_DAYS}d`} with a clean snapshot: ${cands.length}`);
  for (const [k, v] of Object.entries(byCadence)) console.log(`  ${k.padEnd(10)} ${v.length}`);

  // ── pick the wave: round-robin across cadences, preferring multi-line ───────
  const pools = Object.entries(byCadence).map(([, v]) =>
    [...v].sort((a, b) => (b.lines - a.lines) || (a.due < b.due ? -1 : 1)),
  );
  const wave: Cand[] = [];
  for (let i = 0; wave.length < SIZE; i++) {
    let progressed = false;
    for (const p of pools) {
      if (p[i]) { wave.push(p[i]); progressed = true; if (wave.length >= SIZE) break; }
    }
    if (!progressed) break;
  }

  console.log(`\nwave: ${wave.length} contract(s), ${money(wave.reduce((t, c) => t + c.monthlyCents, 0))}/cycle`);
  for (const c of wave) {
    console.log(`  ${c.contractId.padEnd(13)} due ${c.due}  ${c.cadence.padEnd(9)} ${c.lines} line(s)  ${money(c.monthlyCents)}`);
  }

  if (!DRY && !APPLY) { console.log("\nreport only — pass --dry to plan each (vendor reads), or --apply to migrate"); return; }

  // ── execute ────────────────────────────────────────────────────────────────
  console.log(`\n=== ${APPLY ? "MIGRATING" : "DRY RUN"} ${wave.length} contract(s) ===`);
  const outcomes: Record<string, number> = {};
  const failures: string[] = [];
  for (const [n, c] of wave.entries()) {
    const r = await executeMigration(WORKSPACE_ID, c.contractId, ctx, { dryRun: !APPLY });
    const key = r.ok ? "ok" : `${r.stage}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    const detail = r.ok
      ? `→ ${r.newContractId ?? "(dry)"}`
      : `✗ ${r.stage}: ${r.error}${r.drift?.length ? ` (${r.drift.length} drift)` : ""}`;
    console.log(`  [${String(n + 1).padStart(2)}/${wave.length}] ${c.contractId} ${detail}`);
    if (!r.ok) failures.push(`${c.contractId}: ${r.stage} — ${r.error}`);
    await sleep(PACE_MS);
  }

  console.log(`\noutcomes: ${JSON.stringify(outcomes)}`);
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log(`  ${f}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
