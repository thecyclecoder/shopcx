/**
 * Verify-and-finish contracts the wave CREATED but never swapped.
 *
 * A create that succeeds and a verify that then rejects leaves the customer billed by Appstle and
 * a live inert contract on Shopify — safe, but stranded, because the marker makes a plain re-run
 * say "already migrated". This re-enters at the verify step against the contract that exists.
 *
 *   npx tsx scripts/_resume-wave.ts            # verify only, no swap
 *   npx tsx scripts/_resume-wave.ts --swap     # verify, then complete the swap
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
const SWAP = process.argv.includes("--swap");
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const ONE = arg("--contract");
const LIMIT = Number(arg("--limit") ?? 100);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { loadPricingContext, executeMigration } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();
  const ctx = await loadPricingContext(WS, RULE);

  let q = admin.from("appstle_contract_snapshots")
    .select("appstle_contract_id, migrated_to_contract_id")
    .eq("workspace_id", WS)
    .not("migrated_to_contract_id", "is", null)
    .is("migration_completed_at", null);
  if (ONE) q = q.eq("appstle_contract_id", ONE);
  const { data: pending } = await q;

  console.log(`${pending?.length ?? 0} created-but-unswapped contract(s); ${SWAP ? "VERIFY + SWAP" : "verify only"}\n`);
  const outcomes: Record<string, number> = {};
  const failures: string[] = [];
  for (const [n, p] of (pending ?? []).slice(0, LIMIT).entries()) {
    const r = await executeMigration(WS, p.appstle_contract_id as string, ctx, { resume: true, completeSwap: SWAP });
    outcomes[r.ok ? (SWAP ? "swapped" : "verified") : r.stage] = (outcomes[r.ok ? (SWAP ? "swapped" : "verified") : r.stage] ?? 0) + 1;
    console.log(`  [${String(n + 1).padStart(2)}] ${p.appstle_contract_id} → ${r.ok ? (SWAP ? "SWAPPED" : "verified ok") : `✗ ${r.stage}: ${r.error}`}`);
    if (!r.ok) failures.push(`${p.appstle_contract_id}: ${r.stage} — ${r.error}`);
    await sleep(900);
  }
  console.log(`\noutcomes: ${JSON.stringify(outcomes)}`);
  if (failures.length) { console.log(`\n${failures.length} failure(s):`); for (const f of failures) console.log(`  ${f}`); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
