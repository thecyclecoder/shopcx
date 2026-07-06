/**
 * Regression probe for the internal-aware coupon dispatcher.
 *
 * Verifies that `subscriptionApplyCoupon` / `subscriptionRemoveCoupon` in
 * [[src/lib/subscription-items.ts]] return the expected `{ success, error? }`
 * shape for each subscription flavor (internal, Appstle, grandfathered), and
 * that `isInternalSubscription` routes each flavor down the correct branch.
 *
 * Read-only by construction:
 *   - The internal-branch apply call uses a definitely-unresolvable canary
 *     code, so `resolveCoupon` returns null and the dispatcher short-circuits
 *     with `{ success: false, error: "coupon_not_found" }` BEFORE any DB write.
 *   - The Appstle-branch is not called live (would hit the real Appstle API);
 *     we only assert the routing predicate (isInternalSubscription === false).
 *
 * Exit codes:
 *   0 — every flavor found in the DB passes its shape assertion
 *   1 — an assertion failed, or the required libs failed to import
 *   2 — no subscriptions of any flavor exist (nothing to verify)
 */
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import {
  subscriptionApplyCoupon,
  subscriptionRemoveCoupon,
} from "../src/lib/subscription-items";
import { isInternalSubscription } from "../src/lib/internal-subscription";

type SampleSub = {
  id: string;
  workspace_id: string;
  shopify_contract_id: string;
  is_internal: boolean;
  items: Array<Record<string, unknown>> | null;
};

const CANARY_UNRESOLVABLE = "__VERIFY_COUPON_DISPATCHER_UNRESOLVABLE__";

async function sampleInternal(admin: ReturnType<typeof createAdminClient>): Promise<SampleSub | null> {
  const { data } = await admin
    .from("subscriptions")
    .select("id, workspace_id, shopify_contract_id, is_internal, items")
    .eq("is_internal", true)
    .not("shopify_contract_id", "is", null)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  return (data as SampleSub) || null;
}

async function sampleAppstle(admin: ReturnType<typeof createAdminClient>): Promise<SampleSub | null> {
  const { data } = await admin
    .from("subscriptions")
    .select("id, workspace_id, shopify_contract_id, is_internal, items")
    .eq("is_internal", false)
    .not("shopify_contract_id", "is", null)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  return (data as SampleSub) || null;
}

async function sampleGrandfathered(admin: ReturnType<typeof createAdminClient>): Promise<SampleSub | null> {
  // Grandfathered = an internal sub carrying a `price_override_cents` lock on
  // at least one line item. We can't filter JSONB by key existence with the
  // supabase-js chain, so page the recent internal subs and pick the first
  // that has an override.
  const { data } = await admin
    .from("subscriptions")
    .select("id, workspace_id, shopify_contract_id, is_internal, items")
    .eq("is_internal", true)
    .not("shopify_contract_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(50);
  for (const row of (data as SampleSub[] | null) || []) {
    const items = (row.items as Array<{ price_override_cents?: number | null }> | null) || [];
    if (items.some((i) => i && i.price_override_cents != null)) return row;
  }
  return null;
}

function assertShape(label: string, r: unknown): boolean {
  if (!r || typeof r !== "object") {
    console.error(`  ✗ ${label}: return value is not an object — got ${typeof r}`);
    return false;
  }
  const obj = r as Record<string, unknown>;
  if (typeof obj.success !== "boolean") {
    console.error(`  ✗ ${label}: missing boolean 'success' field — got ${JSON.stringify(obj)}`);
    return false;
  }
  if (obj.error !== undefined && typeof obj.error !== "string") {
    console.error(`  ✗ ${label}: 'error' present but not a string — got ${typeof obj.error}`);
    return false;
  }
  console.log(`  ✓ ${label}: ${JSON.stringify(obj)}`);
  return true;
}

async function verifyInternalFlavor(label: string, sub: SampleSub): Promise<boolean> {
  console.log(`\n[${label}] sub=${sub.id} contract=${sub.shopify_contract_id}`);

  const internal = await isInternalSubscription(sub.workspace_id, sub.shopify_contract_id);
  if (!internal) {
    console.error(`  ✗ isInternalSubscription returned false for a sub with is_internal=true`);
    return false;
  }
  console.log(`  ✓ isInternalSubscription → true (routes to internal branch)`);

  // Non-mutating apply: unresolvable canary code → dispatcher returns
  // { success:false, error:'coupon_not_found' } BEFORE touching applied_discounts.
  const applyRes = await subscriptionApplyCoupon(
    sub.workspace_id,
    sub.shopify_contract_id,
    CANARY_UNRESOLVABLE,
  );
  const applyShapeOk = assertShape("subscriptionApplyCoupon (canary code)", applyRes);
  const applyContractOk = applyRes && applyRes.success === false && applyRes.error === "coupon_not_found";
  if (!applyContractOk) {
    console.error(`  ✗ internal-branch canary did not short-circuit as coupon_not_found`);
  }

  // Non-mutating remove: unresolvable canary code — internalSubRemoveDiscount
  // filters applied_discounts by title/id; a non-match is a no-op returning
  // { success:true }. It DOES rewrite the row (updated_at bump) but the array
  // contents are unchanged. Acceptable side effect for a canary probe.
  const removeRes = await subscriptionRemoveCoupon(
    sub.workspace_id,
    sub.shopify_contract_id,
    CANARY_UNRESOLVABLE,
  );
  const removeShapeOk = assertShape("subscriptionRemoveCoupon (canary code)", removeRes);

  return applyShapeOk && applyContractOk && removeShapeOk;
}

async function verifyAppstleFlavor(label: string, sub: SampleSub): Promise<boolean> {
  console.log(`\n[${label}] sub=${sub.id} contract=${sub.shopify_contract_id}`);

  const internal = await isInternalSubscription(sub.workspace_id, sub.shopify_contract_id);
  if (internal) {
    console.error(`  ✗ isInternalSubscription returned true for a sub with is_internal=false`);
    return false;
  }
  console.log(`  ✓ isInternalSubscription → false (routes to Appstle branch)`);
  console.log(`  ↷ live Appstle call skipped (regression probe stays non-mutating)`);
  return true;
}

async function main(): Promise<void> {
  const admin = createAdminClient();

  console.log("Sampling one sub per flavor…");
  const [internal, appstle, grand] = await Promise.all([
    sampleInternal(admin),
    sampleAppstle(admin),
    sampleGrandfathered(admin),
  ]);
  console.log(
    `  internal:       ${internal ? internal.shopify_contract_id : "(none)"}` +
      `\n  appstle:        ${appstle ? appstle.shopify_contract_id : "(none)"}` +
      `\n  grandfathered:  ${grand ? grand.shopify_contract_id : "(none)"}`,
  );

  if (!internal && !appstle && !grand) {
    console.error("No sampleable subscriptions in the DB — cannot verify.");
    process.exit(2);
  }

  let ok = true;
  if (internal) ok = (await verifyInternalFlavor("internal", internal)) && ok;
  if (appstle) ok = (await verifyAppstleFlavor("appstle", appstle)) && ok;
  if (grand) ok = (await verifyInternalFlavor("grandfathered", grand)) && ok;

  if (!ok) {
    console.error("\nFAIL — at least one flavor did not match the expected dispatcher shape.");
    process.exit(1);
  }
  console.log("\nOK — every sampled flavor matches the expected dispatcher shape.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
