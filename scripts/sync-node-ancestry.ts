/**
 * scripts/sync-node-ancestry.ts — mirror the canonical node registry into public.node_ancestry.
 *
 * The DB-side chokepoint of the kill-switch cascade (claim-rpc-kill-switch-enforcement Phase 1):
 * `public.claim_agent_job` walks `public.node_ancestry` in SQL to reject any queued row whose
 * kind is under a switched-off ancestor. This script recomputes the mirror from the frozen
 * `NODES` graph in `src/lib/control-tower/node-registry.ts` and upserts it. Idempotent — a re-run
 * over an in-sync mirror is a no-op.
 *
 *   npx tsx scripts/sync-node-ancestry.ts    # one-shot sync (box startup / manual deploy hook)
 *
 * Best-effort against Supabase; a failure exits non-zero so a wrapping cron can log it. The
 * claim RPC is fail-open, so an out-of-date mirror is not a live outage — it just means a
 * newly-registered kind is not yet gated by the switch.
 */
import "./_bootstrap";
import { syncNodeAncestry } from "../src/lib/control-tower/node-ancestry-sync";

async function main() {
  const result = await syncNodeAncestry();
  console.log(result.detail);
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
