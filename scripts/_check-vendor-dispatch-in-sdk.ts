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
