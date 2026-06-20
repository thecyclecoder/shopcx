/**
 * One-off (first use of `remove_line`, composed with `shipping_protection_convert`):
 * repair the stuck migration for sub `e4589de9` (audit `4b831caa`).
 *
 * Two failures, two deterministic gated fixes — both now available:
 *   1. items_on_uuids — a FREE "ACV Gummies" promo line ($0, no catalog variant)
 *      was dragged across by the old migration logic. It has no product_variants
 *      row and shouldn't carry over, so we DELETE it (remove_line) — not backfill
 *      (we don't want to keep it).
 *   2. pricing_preserved — the Appstle "Shipping Protection" line ($3.95) was
 *      migrated into items[] and the flag was never set, so the baseline over-counts
 *      the product subtotal by the protection amount. Convert it to the internal
 *      flag (shipping_protection_convert): set shipping_protection_added/_amount_cents,
 *      drop the protection line, correct the audit baseline → product-only $59.96.
 *
 * Result: Tabs stays at $59.96 (override UNTOUCHED — we never raise a product
 * override), protection bills $3.95 via the flag, sub renews at $63.91, and BOTH
 * items_on_uuids + pricing_preserved clear → the row passes.
 *
 * Admin-client only (no raw pooler dependency). Dry-run by default; pass --apply to
 * mutate. Idempotent (both fixes are no-ops once applied). See
 * docs/brain/specs/migration-fix-remove-line.md.
 *
 * NOTE: deliberately NOT `_`-prefixed — `.gitignore` ignores `scripts/_*`, and this
 * one-off must be tracked so the build/worker commit picks it up before running it.
 */
import { createAdminClient } from "./_bootstrap";
import { applyMigrationFix } from "../src/lib/migration-fix";
import { verifyMigration } from "../src/lib/migration-audit";

const SUB_PREFIX = "e4589de9";
const REMOVE_LINE_TITLE = "ACV Gummies"; // the free $0 promo line with no catalog variant
const PROTECTION_AMOUNT_CENTS = 395; // $3.95 Appstle shipping-protection line → internal flag
const BASELINE_CENTS = 5996; // product-only subtotal ($59.96 Tabs) — excludes protection

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
    console.log(
      `\n[dry-run] would apply (in order):` +
        `\n  1. remove_line { title: "${REMOVE_LINE_TITLE}" }` +
        `\n  2. shipping_protection_convert { amount_cents: ${PROTECTION_AMOUNT_CENTS}, baseline_cents: ${BASELINE_CENTS} }` +
        `\n  then verifyMigration(${audit.id}). Confirm the "${REMOVE_LINE_TITLE}" line above is the free $0 promo line, then re-run with --apply.`,
    );
    return;
  }

  // 1. Remove the free promo line first (items_on_uuids).
  const rm = await applyMigrationFix(admin, audit as Record<string, unknown>, {
    fix_kind: "remove_line",
    payload: { title: REMOVE_LINE_TITLE },
  });
  console.log(`\n[remove_line] ok=${rm.ok} — ${rm.detail}`);
  if (!rm.ok) throw new Error(`remove_line failed: ${rm.detail}`);

  // 2. Convert the protection line → flag + correct the baseline (pricing_preserved).
  const prot = await applyMigrationFix(admin, audit as Record<string, unknown>, {
    fix_kind: "shipping_protection_convert",
    payload: { amount_cents: PROTECTION_AMOUNT_CENTS, baseline_cents: BASELINE_CENTS },
  });
  console.log(`[shipping_protection_convert] ok=${prot.ok} — ${prot.detail}`);
  if (!prot.ok) throw new Error(`shipping_protection_convert failed: ${prot.detail}`);

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
  console.log(`\n${verify.status === "passed" ? "OK row cleared — renews $63.91 (Tabs 5996 + protection 395)" : "STILL FAILING — review"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
