/**
 * One-time, idempotent policy update — Phase 1 of
 * docs/brain/specs/return-refund-includes-tax.md.
 *
 * WHY. Founder rule (2026-11-19): "We don't withhold tax amounts from refunds. The only thing we
 * typically don't refund is shipping they paid or shipping protection." The `returns` policy row's
 * authoritative rule `returns.refund_formula` read `order_subtotal - label_cost`, and the two
 * published/internal halves said tax was excluded — so the AI and the storefront both told the
 * customer tax is withheld, matching the (now-fixed) code. The code now adds the tax allocated to
 * the returned lines (`computeReturnNetRefundCents` + `allocateReturnTaxCents` in
 * [[../src/lib/shopify-returns.ts]]); the policy row must say the same thing so the AI obeys the
 * same contract and `scripts/_check-policy-contradictions.ts` stays green.
 *
 * WHAT. Through the policies SDK chokepoint ([[../src/lib/policies.ts]] `updatePolicyText`), for the
 * active `returns` policy in every workspace that has one:
 *   - set the `returns.refund_formula` rule value to `order_subtotal + allocated_tax - label_cost`
 *   - leave `returns.refund_excludes` UNCHANGED (tax is NOT an exclusion; the spec says add nothing)
 *   - update `customer_summary` + `internal_summary` so neither says tax is withheld (match the rule)
 *
 * IDEMPOTENT. A workspace whose formula + summaries already carry the tax wording is left untouched
 * (no version bump — `updatePolicyText` only bumps when content actually changes). Safe to re-run.
 *
 * Ship-time data-op convention: dry-run by default; `--apply` writes. Logs before/after per
 * workspace. Mirrors the seed content in `scripts/seed-policies-v1.ts` (kept in sync in the same PR).
 *
 * Run:  npx tsx scripts/_update-returns-policy-tax.ts            # dry-run (default)
 *       npx tsx scripts/_update-returns-policy-tax.ts --apply    # write
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
} catch {
  /* env may already be present in the box environment */
}

import { createAdminClient } from "../src/lib/supabase/admin";
import { updatePolicyText } from "../src/lib/policies";

const APPLY = process.argv.includes("--apply");

const NEW_FORMULA = "order_subtotal + allocated_tax - label_cost";
const OLD_FORMULA = "order_subtotal - label_cost";

/** Replace the returned-amount prose so neither half says tax is withheld. Idempotent string ops. */
function patchCustomerSummary(s: string): string {
  if (s.includes("including the sales tax")) return s;
  return s.replace(
    /(All products you ordered are eligible for return under the Money-Back Guarantee[^\n]*\n)/,
    `$1\nYour refund covers what you paid for the product, **including the sales tax** charged on it.\n`,
  );
}

function patchInternalSummary(s: string): string {
  let out = s;
  out = out.replace(
    "Order subtotal is refunded.",
    "Order subtotal PLUS the tax allocated to the returned product is refunded.",
  );
  out = out.replace(
    "Refund math: net_refund = order_subtotal − label_cost.",
    "Refund math: net_refund = order_subtotal + allocated_tax − label_cost. Tax is NOT withheld; only paid shipping and shipping protection are.",
  );
  return out;
}

async function main() {
  const admin = createAdminClient();

  // Enumerate workspaces, then resolve each one's active `returns` policy through the policies SDK
  // (`getPolicy` below) — a raw policies-table read is forbidden by
  // `scripts/_check-policies-sdk-compliance.ts` (a hand-rolled column silently reads empty). Reading
  // the `workspaces` table directly is fine; workspaces without a returns policy are skipped in the
  // loop via `getPolicy(...) === null`.
  const { data: rows, error } = await admin.from("workspaces").select("id");
  if (error) throw new Error(`read workspaces: ${error.message}`);
  const workspaceIds = Array.from(new Set((rows ?? []).map((r) => String(r.id))));
  if (workspaceIds.length === 0) {
    console.log("No workspaces found — nothing to do.");
    return;
  }

  const { getPolicy } = await import("../src/lib/policies");
  for (const workspaceId of workspaceIds) {
    const policy = await getPolicy(admin, workspaceId, "returns");
    if (!policy) continue;

    const rules = Array.isArray(policy.rules) ? (policy.rules as Array<Record<string, unknown>>) : [];
    const nextRules = rules.map((r) =>
      r && r.id === "returns.refund_formula" ? { ...r, value: NEW_FORMULA } : r,
    );
    const formulaRule = rules.find((r) => r && r.id === "returns.refund_formula");
    const currentFormula = formulaRule ? String(formulaRule.value) : "(none)";

    const nextCustomer = patchCustomerSummary(policy.customer_summary);
    const nextInternal = patchInternalSummary(policy.internal_summary);

    const formulaChanged = currentFormula !== NEW_FORMULA;
    const customerChanged = nextCustomer !== policy.customer_summary;
    const internalChanged = nextInternal !== policy.internal_summary;

    console.log(`\n── workspace ${workspaceId} ──`);
    console.log(`  refund_formula: ${currentFormula}${formulaChanged ? ` → ${NEW_FORMULA}` : "  (already tax-inclusive)"}`);
    console.log(`  customer_summary: ${customerChanged ? "will update (add sales-tax line)" : "already tax-inclusive"}`);
    console.log(`  internal_summary: ${internalChanged ? "will update (formula + refund-amount prose)" : "already tax-inclusive"}`);
    if (currentFormula !== OLD_FORMULA && currentFormula !== NEW_FORMULA) {
      console.log(`  ⚠ formula is neither the known old nor new value — review before applying.`);
    }

    if (!formulaChanged && !customerChanged && !internalChanged) {
      console.log("  ✓ already fully migrated — no write.");
      continue;
    }
    if (!APPLY) {
      console.log("  (dry-run — pass --apply to write)");
      continue;
    }
    const res = await updatePolicyText(admin, workspaceId, "returns", {
      rules: nextRules,
      customer_summary: nextCustomer,
      internal_summary: nextInternal,
      updated_by: null, // policies.updated_by is a uuid column; a "spec:<slug>" tag here 22P02-errors every run
    });
    console.log(`  ✓ wrote v${res.version}${res.versionBumped ? " (bumped)" : ""}`);
  }

  console.log(`\nDone${APPLY ? " (applied)" : " (dry-run)"}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
