/**
 * scripts/sync-inngest.ts — force Inngest to re-register the app's served functions.
 *
 * The deploy-time re-sync (control-tower-complete-coverage spec, Phase 2): PUTs the serve
 * endpoint so a newly-added `createFunction` registers with Inngest Cloud instead of silently
 * never firing (the control-tower-monitor "awaiting first run for days" gap). The box build
 * worker runs the same syncInngestRegistration() on startup; this script is the manual /
 * deploy-hook entry point.
 *
 *   npx tsx scripts/sync-inngest.ts                       # PUT the prod serve endpoint
 *   npx tsx scripts/sync-inngest.ts https://x/api/inngest # PUT a specific endpoint
 *
 * Read-only against our DB (no Supabase writes); it only pings the public serve URL.
 */
import "./_bootstrap";
import { syncInngestRegistration } from "../src/lib/inngest/sync";

async function main() {
  const url = process.argv[2];
  const result = await syncInngestRegistration(url);
  console.log(result.detail);
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
