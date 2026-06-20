/**
 * One-off (first use of `shipping_protection_convert`): repair the stuck migration
 * for sub `4b831caa` — the Appstle "Shipping Protection" line ($3.75) was migrated
 * into items[] as a bogus product line and the flag was never set, so
 * `pre_migration_charge_cents` (6371¢) over-counts the engine's product subtotal
 * (5996¢) by the protection amount and `pricing_preserved` fails.
 *
 * Applies the deterministic gated fix via `applyMigrationFix(shipping_protection_convert)`:
 *   - shipping_protection_added = true, shipping_protection_amount_cents = 375
 *   - remove the "Shipping Protection" line from items[] (Superfood Tabs stays at
 *     5996, override UNTOUCHED — we never raise a product override)
 *   - correct the audit baseline 6371¢ → 5996¢
 * then re-runs verifyMigration → expect `pricing_preserved` passes and the row clears.
 *
 * The customer still renews at the same total (5996 + 375 = 6371).
 *
 * Admin-client only (no raw pooler dependency). Dry-run by default; pass --apply to
 * mutate. Idempotent. See docs/brain/specs/migration-shipping-protection.md.
 *
 * NOTE: deliberately NOT `_`-prefixed — `.gitignore` ignores `scripts/_*`, and this
 * one-off must be tracked so the build/worker commit picks it up before running it.
 */
import { createAdminClient } from "./_bootstrap";
import { applyMigrationFix } from "../src/lib/migration-fix";
import { verifyMigration } from "../src/lib/migration-audit";

const SUB_PREFIX = "4b831caa";
const AMOUNT_CENTS = 375;
const BASELINE_CENTS = 5996;

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  // Resolve the at-risk audit by its subscription_id prefix using ONLY the
  // service-role admin client (PostgREST can't LIKE a uuid column, and the raw
  // pooler password may be absent on the box). Latest audit for the sub wins.
  const { data: audits } = await admin
    .from("migration_audits")
    .select("*")
    .order("created_at", { ascending: false });
  const audit = (audits || []).find((a) => String(a.subscription_id || "").startsWith(SUB_PREFIX));
  if (!audit) throw new Error(`no migration_audits row whose subscription_id starts with ${SUB_PREFIX}`);
  const subId = String(audit.subscription_id);
  console.log(`[fix] sub ${subId} · audit ${audit.id}`);

  const { data: subBefore } = await admin
    .from("subscriptions")
    .select("id, items, shipping_protection_added, shipping_protection_amount_cents")
    .eq("id", subId)
    .maybeSingle();

  console.log("\n[before]");
  console.log(`  audit status=${audit.status} pre_migration_charge_cents=${audit.pre_migration_charge_cents}`);
  console.log(`  shipping_protection_added=${subBefore?.shipping_protection_added} amount=${subBefore?.shipping_protection_amount_cents}`);
  console.log(`  items=${JSON.stringify(subBefore?.items)}`);

  if (!apply) {
    console.log(`\n[dry-run] would apply shipping_protection_convert { amount_cents: ${AMOUNT_CENTS}, baseline_cents: ${BASELINE_CENTS} } then verifyMigration(${audit.id}). Re-run with --apply.`);
    return;
  }

  const res = await applyMigrationFix(admin, audit as Record<string, unknown>, {
    fix_kind: "shipping_protection_convert",
    payload: { amount_cents: AMOUNT_CENTS, baseline_cents: BASELINE_CENTS },
  });
  console.log(`\n[applyMigrationFix] ok=${res.ok} — ${res.detail}`);
  if (!res.ok) throw new Error(`fix failed: ${res.detail}`);

  const verify = await verifyMigration(audit.id as string);
  console.log(`\n[verifyMigration] status=${verify.status}`);
  for (const ch of verify.checks) console.log(`  ${ch.ok ? "PASS" : "FAIL"} ${ch.key}${ch.detail ? ` — ${ch.detail}` : ""}`);

  const { data: subAfter } = await admin
    .from("subscriptions")
    .select("id, items, shipping_protection_added, shipping_protection_amount_cents")
    .eq("id", subId)
    .maybeSingle();
  console.log("\n[after]");
  console.log(`  shipping_protection_added=${subAfter?.shipping_protection_added} amount=${subAfter?.shipping_protection_amount_cents}`);
  console.log(`  items=${JSON.stringify(subAfter?.items)}`);
  console.log(`\n${verify.status === "passed" ? "OK row cleared" : "STILL FAILING — review"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
