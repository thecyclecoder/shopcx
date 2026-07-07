/**
 * Poll public.specs until the box worker has authored all 9 Centralized Commerce
 * SDK specs (the resumed plan job). Exits 0 when all present, 2 on timeout.
 * Run in background so the session is re-invoked on exit.
 */
import "./_bootstrap";
import { getSpec } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS = [
  "returns-refund-internal-aware-dispatcher",
  "subscription-coupon-internal-aware-dispatcher",
  "commerce-sdk-scaffold-money-resolver",
  "commerce-sdk-display-operations",
  "commerce-sdk-mutations-rename-subscription-prefix",
  "commerce-sdk-differential-harness",
  "commerce-sdk-migrate-ticket-detail",
  "commerce-sdk-migrate-dashboard-agent-ai",
  "commerce-sdk-migrate-customer-portal",
];
const MAX_ATTEMPTS = 60; // ~45 min at 45s
const INTERVAL_MS = 45_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const present: string[] = [];
    for (const slug of SLUGS) {
      const s = await getSpec(WS, slug);
      if (s) present.push(`${slug}[${s.status}]`);
    }
    console.log(`[attempt ${i}/${MAX_ATTEMPTS}] ${present.length}/9 authored`);
    if (present.length === SLUGS.length) {
      console.log("ALL 9 AUTHORED:");
      for (const p of present) console.log("  " + p);
      process.exit(0);
    }
    if (i < MAX_ATTEMPTS) await sleep(INTERVAL_MS);
  }
  console.log("TIMEOUT — not all 9 authored yet.");
  process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
