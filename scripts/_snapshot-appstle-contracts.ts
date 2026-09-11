/**
 * Pull every migrating Appstle contract into `appstle_contract_snapshots`.
 *
 * WHY: Appstle bills per API call. ~2,478 contracts migrate, so re-reading live on every dry run
 * costs 2,478 hits EACH TIME. Snapshot once here; every subsequent migration dry run then plans
 * off local data at zero vendor cost. The migrator still re-reads each single contract at write
 * time as a staleness guard — this table drives PLANNING, never the write.
 *
 * SAFE BY DEFAULT: prints the population and exits. Pass --run to actually call Appstle.
 *
 *   npx tsx scripts/_snapshot-appstle-contracts.ts                  # plan only
 *   npx tsx scripts/_snapshot-appstle-contracts.ts --run --limit 10 # small real pull
 *   npx tsx scripts/_snapshot-appstle-contracts.ts --run            # full pull
 *   npx tsx scripts/_snapshot-appstle-contracts.ts --run --retry-errors
 *   npx tsx scripts/_snapshot-appstle-contracts.ts --run --force    # re-pull everything
 *
 * Resumable: a contract already snapshotted WITHOUT an error is skipped unless --force. Killing
 * it mid-run and re-running costs only the remainder.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

/** Politeness delay between vendor calls. Appstle is metered AND rate limited. */
const DELAY_MS = 150;
/** Cooloff ladder on a 429/503. Dylan's rule: hit a rate limit, back off — don't hammer. */
const COOLOFF_MS = [5_000, 15_000, 45_000, 120_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const argv = process.argv;
  const run = argv.includes("--run");
  const force = argv.includes("--force");
  const retryErrors = argv.includes("--retry-errors");
  const limArg = argv.indexOf("--limit");
  const limit = limArg >= 0 ? parseInt(argv[limArg + 1], 10) : Infinity;

  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { snapshotAppstleContract } = await import("../src/lib/appstle-snapshot");
  const admin = createAdminClient();

  // Migration population: active + paused, Appstle-backed (internal-* subs are already ours).
  const subs: { id: string; shopify_contract_id: string; status: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, status")
      .eq("workspace_id", WORKSPACE_ID)
      .in("status", ["active", "paused"])
      .not("shopify_contract_id", "like", "internal-%")
      .range(from, from + 999);
    if (error) throw new Error(`subscriptions select failed: ${error.message}`);
    if (!data?.length) break;
    subs.push(...(data as typeof subs));
    if (data.length < 1000) break;
  }

  // Existing snapshots (paginated — this table will outgrow 1000 rows immediately).
  const done = new Map<string, string | null>();
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("appstle_contract_snapshots")
      .select("appstle_contract_id, fetch_error")
      .eq("workspace_id", WORKSPACE_ID)
      .range(from, from + 999);
    if (!data?.length) break;
    data.forEach((r: { appstle_contract_id: string; fetch_error: string | null }) =>
      done.set(r.appstle_contract_id, r.fetch_error));
    if (data.length < 1000) break;
  }

  const todo = subs.filter((s) => {
    if (force) return true;
    if (!done.has(s.shopify_contract_id)) return true;
    return retryErrors && done.get(s.shopify_contract_id) != null;
  }).slice(0, limit);

  const byStatus = subs.reduce<Record<string, number>>((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
  console.log(`migration population: ${subs.length}  ${JSON.stringify(byStatus)}`);
  console.log(`already snapshotted : ${done.size}  (with errors: ${[...done.values()].filter(Boolean).length})`);
  console.log(`to pull this run    : ${todo.length}`);
  if (!run) {
    console.log(`\nDRY — no Appstle calls made. Re-run with --run (optionally --limit N).`);
    return;
  }
  if (!todo.length) { console.log("\nnothing to do."); return; }

  console.log(`\ncalling Appstle for ${todo.length} contract(s)...\n`);
  let ok = 0, failed = 0, cool = 0;
  const errors: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    let attempt = 0;
    for (;;) {
      const r = await snapshotAppstleContract(WORKSPACE_ID, s.shopify_contract_id, s.id);
      if (r.ok) { ok++; break; }
      if (r.rateLimited && attempt < COOLOFF_MS.length) {
        const wait = COOLOFF_MS[attempt++];
        cool++;
        console.log(`   rate limited — cooling off ${wait / 1000}s (attempt ${attempt})`);
        await sleep(wait);
        continue;
      }
      failed++;
      if (errors.length < 15) errors.push(`${s.shopify_contract_id}: ${r.error}`);
      break;
    }
    if ((i + 1) % 50 === 0 || i === todo.length - 1) {
      console.log(`   ${i + 1}/${todo.length}   ok=${ok} failed=${failed} cooloffs=${cool}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\ndone.  ok=${ok}  failed=${failed}  cooloffs=${cool}`);
  if (errors.length) { console.log(`\nfirst errors:`); errors.forEach((e) => console.log(`   ${e}`)); }
  console.log(`\nfailed rows are PERSISTED with fetch_error set — re-run with --run --retry-errors.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
