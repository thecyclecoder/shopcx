/**
 * Commerce SDK parity audit — dashboard slice.
 *
 * Gate for the spec `commerce-sdk-migrate-dashboard-agent-ai` Phase 1
 * verification bullet ("On scripts/audit-sdk-parity.ts scoped to the
 * dashboard slice, expect exit 0"). The dashboard commerce surfaces —
 * subscription / order / return / replacement / loyalty / chargeback /
 * fraud / crisis — must satisfy TWO structural invariants:
 *
 *   1. No dashboard PAGE file (`src/app/dashboard/**`) reads a commerce
 *      entity table directly. All commerce reads route through per-page
 *      API routes; the page tree is client-only and hits `fetch()`.
 *      Grep target: `.from("subscriptions" | "orders" | "returns" |
 *      "replacements" | "chargebacks" | "customer_fraud_status")`.
 *
 *   2. The Apply-Coupon UI is EXPOSED on subscription-detail (not
 *      remove-only) — verification bullet #4 of the same spec.
 *      Marker: the file `src/app/dashboard/subscriptions/[id]/page.tsx`
 *      contains an `Apply` button wired to `/coupon` (matches the
 *      pattern the Phase-1 landing shipped).
 *
 * READ-ONLY BY CONSTRUCTION: uses `fs` to inspect source files only. No
 * DB / network calls. Exits 0 if both invariants hold, non-zero + a
 * per-invariant diagnosis otherwise.
 *
 * Usage:
 *   npx tsx scripts/audit-sdk-parity.ts [--dashboard]
 *
 * (The `--dashboard` flag is accepted for forward compatibility with the
 * cross-slice audit variant; the current script is dashboard-scoped.)
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "..");
const DASHBOARD_DIR = join(ROOT, "src/app/dashboard");
const SUBSCRIPTION_DETAIL = join(
  ROOT,
  "src/app/dashboard/subscriptions/[id]/page.tsx",
);

const COMMERCE_TABLES = [
  "subscriptions",
  "orders",
  "returns",
  "replacements",
  "chargebacks",
  "customer_fraud_status",
];

function walk(dir: string, hits: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, hits);
    else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) hits.push(p);
  }
}

function invariantOneNoRawCommerceReadsFromDashboardPages(): { ok: boolean; sample: string[] } {
  const files: string[] = [];
  walk(DASHBOARD_DIR, files);
  const offenders: string[] = [];
  for (const f of files) {
    let body: string;
    try {
      body = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const table of COMMERCE_TABLES) {
      const needleDouble = `.from("${table}"`;
      const needleSingle = `.from('${table}'`;
      if (body.includes(needleDouble) || body.includes(needleSingle)) {
        offenders.push(`${f.replace(ROOT + "/", "")} — hits .from("${table}")`);
      }
    }
  }
  return { ok: offenders.length === 0, sample: offenders };
}

function invariantTwoApplyCouponUiExposedOnSubscriptionDetail(): { ok: boolean; reason?: string } {
  let body: string;
  try {
    body = readFileSync(SUBSCRIPTION_DETAIL, "utf8");
  } catch (e) {
    return { ok: false, reason: `Could not read ${SUBSCRIPTION_DETAIL}: ${(e as Error).message}` };
  }
  // Marker: an "Apply" button (or apply_coupon action state) that POSTs to /coupon.
  // Matches what the Phase-1 landing shipped: the form + button live inside the
  // Applied-Discounts panel and hit /subscriptions/${subId}/coupon with POST.
  const hasApplyState = body.includes("apply_coupon");
  const hasCouponEndpoint = body.includes("/coupon");
  const hasPostMethod = body.includes('method: "POST"');
  if (!hasApplyState || !hasCouponEndpoint || !hasPostMethod) {
    return {
      ok: false,
      reason: `Missing Apply-Coupon UI markers (apply_coupon=${hasApplyState}, /coupon=${hasCouponEndpoint}, POST=${hasPostMethod})`,
    };
  }
  return { ok: true };
}

function main(): void {
  const inv1 = invariantOneNoRawCommerceReadsFromDashboardPages();
  const inv2 = invariantTwoApplyCouponUiExposedOnSubscriptionDetail();

  const rows = [
    { name: "no raw commerce .from() in src/app/dashboard/**", ok: inv1.ok, detail: inv1.sample.slice(0, 5) },
    { name: "Apply-Coupon UI exposed on subscription-detail", ok: inv2.ok, detail: inv2.reason ? [inv2.reason] : [] },
  ];

  const allOk = rows.every((r) => r.ok);
  for (const r of rows) {
    const stamp = r.ok ? "PASS" : "FAIL";
    console.log(`[${stamp}] ${r.name}`);
    for (const line of r.detail) console.log(`         · ${line}`);
  }

  if (!allOk) {
    console.error("\naudit-sdk-parity.ts (dashboard slice): FAIL");
    process.exit(1);
  }
  console.log("\naudit-sdk-parity.ts (dashboard slice): OK");
  process.exit(0);
}

main();
