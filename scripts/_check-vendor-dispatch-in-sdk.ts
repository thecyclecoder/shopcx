/**
 * Static-analysis check: the commerce SDK owns engine dispatch — vendor modules do NOT.
 *
 * `src/lib/appstle.ts` used to dispatch: ten of its functions opened with
 * `if (await isInternalSubscription(...)) return internalSub*(...)`. That was sound for TWO engines
 * — "not internal ⇒ Appstle" is exhaustive — and it is why direct calls like
 * `appstleUpdateNextBillingDate(...)` from portal handlers were CORRECT rather than careless.
 *
 * Adding a third engine (ShopCX-owned Shopify contracts) invalidated the assumption silently: such
 * a contract is not internal, so it fell through to a vendor that does not hold it, failed there,
 * and returned BEFORE the local write — the customer's change vanished with no error anyone saw.
 *
 * Two rules, both mechanical:
 *   1. A vendor module must not import `isInternalSubscription` / `resolveBillingSource`. If it
 *      needs to know the engine, the dispatch is in the wrong place.
 *   2. Nothing outside the SDK may CALL a dispatching vendor function directly.
 *
 * The point is that the NEXT engine needs one new branch in one file, and a stray vendor call is a
 * red build rather than behaviour that happens to be right today.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** Vendor functions that the commerce SDK must be the sole caller of. */
const DISPATCHED_VENDOR_FNS = [
  "appstleSubscriptionAction",
  "appstleSkipNextOrder",
  "appstleSkipUpcomingOrder",
  "appstleUpdateBillingInterval",
  "appstleUpdateNextBillingDate",
  "appstleGetUpcomingOrders",
  "appstleSwitchPaymentMethod",
  "appstleSendPaymentUpdateEmail",
  "appstleAddFreeProduct",
  "appstleSwapProduct",
  "appstleOrderNowByContract",
];

/**
 * Vendor modules, which must stay dispatch-free.
 *
 * The line is DISPATCH, not engine-awareness: a vendor may DECLINE work that is not its own
 * (return an empty/no-op result and route nowhere) — that is safe for an engine nobody has
 * written yet. What it may not do is hand the call to another engine, because then "not mine ⇒
 * theirs" is baked in and the next engine silently takes someone else's path.
 * `healAppstleContract` in appstle-pricing.ts is a decline and is deliberately NOT listed.
 */
const VENDOR_MODULES = ["src/lib/appstle.ts", "src/lib/appstle-discount.ts"];

/**
 * Files allowed to call a dispatching vendor function directly. Keep this SHORT and justified —
 * an entry here is a caller that will not follow the engine.
 */
const ALLOW: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "src/lib/commerce/subscription.ts", reason: "the SDK — it IS the dispatcher" },
  { path: "src/lib/migration-audit.ts", reason: "cancels a LINGERING Appstle contract by its old id; the vendor really is the target" },
  { path: "src/lib/migration-fix.ts", reason: "same — heals a contract the subscriptions row no longer points at" },
];

/**
 * Rule 4: engine resolution belongs to the DISPATCH LAYER, not to feature code.
 *
 * The SDK header claims this checker "keeps that resolution here and out of the vendor modules",
 * but resolution legitimately lives in a handful of chokepoints the SDK delegates to — and
 * NOTHING stopped it spreading further. It has already reached seven portal handlers. Each new
 * site is another place a fourth engine must be remembered, which is the failure mode this whole
 * check exists to prevent.
 *
 * So: resolving the engine is allowed ONLY in the files below. Anything else must call a
 * chokepoint that dispatches for it. Adding a file here should feel like a decision.
 */
const ENGINE_RESOLVERS: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "src/lib/commerce/subscription.ts", reason: "the SDK — it IS the dispatcher" },
  { path: "src/lib/subscription-items.ts", reason: "the line-op + coupon chokepoint the SDK delegates to" },
  { path: "src/lib/coupons.ts", reason: "applyCouponToSub / removeCouponFromSub — the coupon chokepoint" },
  { path: "src/lib/internal-subscription.ts", reason: "defines resolveBillingSource itself" },
  { path: "src/lib/dunning-charge.ts", reason: "the dunning charge chokepoint" },
  { path: "src/lib/migrate-to-internal.ts", reason: "converts BETWEEN engines; must read the source engine" },
  { path: "src/lib/appstle-pricing.ts", reason: "declines non-Appstle work (a decline, not a dispatch — see VENDOR_MODULES)" },
  // Portal handlers + surfaces that legitimately branch. Each is a place a FOURTH engine must be
  // remembered — prefer pushing new branches down into a chokepoint over extending this list.
  { path: "src/lib/portal/handlers/address.ts", reason: "ShopCX address must round-trip to Shopify" },
  { path: "src/lib/portal/handlers/coupon.ts", reason: "Appstle arm has vendor-specific self-heal" },
  { path: "src/lib/portal/handlers/loyalty-apply-subscription.ts", reason: "same Appstle self-heal" },
  { path: "src/lib/portal/handlers/reactivate.ts", reason: "date must reach the contract" },
  { path: "src/lib/portal/handlers/replace-variants.ts", reason: "Appstle arm uses replace-variants-v3" },
  { path: "src/lib/portal/handlers/order-now.ts", reason: "ShopCX charges by cycle key" },
  { path: "src/lib/action-executor.ts", reason: "agent price restore routes before the vendor fetch" },
  { path: "src/lib/dunning-webhook.ts", reason: "a Braintree method cannot attach to a Shopify contract" },
  { path: "src/lib/commerce/shopify-one-time-charge.ts", reason: "picks the Braintree vs Shopify rail" },
  { path: "src/lib/inngest/portal-auto-resume.ts", reason: "only ShopCX needs its cycle calendar re-anchored on resume" },
];

const SCAN_ROOTS = ["src"];
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const violations: string[] = [];

for (const vm of VENDOR_MODULES) {
  let src = "";
  try { src = readFileSync(vm, "utf8"); } catch { continue; }
  src.split("\n").forEach((line, i) => {
    // The helper names AND the raw columns behind them — `appstle-discount.ts` dispatched by
    // selecting `is_internal` inline, which the helper-name check alone would have missed.
    if (
      /\b(isInternalSubscription|resolveBillingSource)\b/.test(line) ||
      /["'`](is_internal|billing_source)["'`]/.test(line) ||
      /\bis_internal\b\s*[),?]/.test(line)
    ) {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//")) return;
      violations.push(`   ${vm}:${i + 1}  vendor module resolves the engine — dispatch belongs in the commerce SDK\n      ${t.slice(0, 110)}`);
    }
  });
}

/**
 * Rule 3: `is_internal = false` is not a class of subscription any more.
 *
 * It used to mean "Appstle", because there were two engines. A ShopCX-billed sub is not internal
 * either, so every such SELECTOR silently widened to include it. `migrateCustomerAppstleSubsToInternal`
 * picked its whole working set this way and ran on PORTAL PAGE LOAD for any customer with a default
 * Braintree card — it would have read the live Appstle contract for a contract Appstle never held,
 * and a flip would have left the row carrying `is_internal=true` AND `billing_source='shopcx'`:
 * billable by the internal renewal cron AND the ShopCX one. A double charge, not a failed migration.
 *
 * `billing_source` is the real predicate and is fully populated (0 NULLs). Writes
 * (`is_internal: true/false`) and reads of an already-loaded row are fine — only the SELECTOR is banned.
 */
for (const file of SCAN_ROOTS.flatMap((r) => walk(r))) {
  const rel = file.replace(/\\/g, "/");
  // storefront_sessions.is_internal is unrelated — it means internal TRAFFIC.
  if (rel.includes("/storefront/")) continue;
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, i) => {
    if (!/\.eq\(\s*["']is_internal["']\s*,\s*false\s*\)/.test(line)) return;
    violations.push(
      `   ${rel}:${i + 1}  selects on is_internal=false — that set now includes ShopCX subs; filter on billing_source instead\n      ${line.trim().slice(0, 110)}`,
    );
  });
}

for (const file of SCAN_ROOTS.flatMap((r) => walk(r))) {
  const rel = file.replace(/\\/g, "/");
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
  if (ENGINE_RESOLVERS.some((e) => rel === e.path)) continue;
  if (VENDOR_MODULES.includes(rel)) continue;
  const src4 = readFileSync(file, "utf8");
  src4.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//")) return;
    if (!/\bresolveBillingSource\s*\(/.test(line)) return;
    violations.push(
      `   ${rel}:${i + 1}  resolves the engine outside the dispatch layer — call a chokepoint instead\n      ${t.slice(0, 110)}`,
    );
  });
}

for (const file of SCAN_ROOTS.flatMap((r) => walk(r))) {
  const rel = file.replace(/\\/g, "/");
  if (VENDOR_MODULES.includes(rel)) continue;
  if (ALLOW.some((a) => rel === a.path)) continue;
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//")) return;      // prose may name them
    for (const fn of DISPATCHED_VENDOR_FNS) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(line)) {
        violations.push(`   ${rel}:${i + 1}  calls ${fn} directly — route it through @/lib/commerce/subscription\n      ${t.slice(0, 110)}`);
      }
    }
  });
}

if (violations.length) {
  console.error(`\n❌ check-vendor-dispatch-in-sdk — ${violations.length} violation(s):\n`);
  violations.forEach((v) => console.error(v));
  console.error(`
   Engine dispatch lives in src/lib/commerce/subscription.ts, which resolves billing_source across
   internal | appstle | shopcx. A vendor module that branches on the engine, or a caller that
   reaches a vendor directly, will silently do the wrong thing for any engine it was not written
   for — which is exactly how a migrated subscription's portal writes vanished.
`);
  process.exit(1);
}
console.log("✅ check-vendor-dispatch-in-sdk — dispatch lives in the SDK; no direct vendor calls");
