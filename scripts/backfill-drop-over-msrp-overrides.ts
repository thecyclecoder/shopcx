/**
 * Repair sweep (Phase 1 of base-price-never-above-msrp): drop every stranded
 * `subscriptions.items[].price_override_cents` that EXCEEDS its catalog MSRP.
 *
 * The base price is the per-unit price BEFORE the −25% S&S discount + quantity
 * breaks. `price_override_cents` exists ONLY to lock a grandfathered base BELOW
 * MSRP; an at-or-above-MSRP override is a no-op at best and inflates the charge at
 * worst (it feeds the rule math from too high a start). The old
 * `inferAppstleLineBase` reverse-engineered some bases ABOVE MSRP and stored them,
 * so the engine prices those subs too high and `pricing_preserved` fails.
 *
 * Fix: for every internal sub line whose `price_override_cents > product_variants.price_cents`
 * (the catalog MSRP), DROP the override key → the engine re-derives the correct
 * rules price from MSRP. First use: Lisa Baker (sub `fdc1d5e3`) → engine subtotal
 * $110.34 → `pricing_preserved` clears. A genuine grandfathered base BELOW MSRP is
 * left untouched. comp subs (override $0) are never affected.
 *
 * After dropping, re-runs `verifyMigration` on each affected sub's latest
 * migration_audit so a cleared row drops off /dashboard/migrations.
 *
 * Admin-client only (no raw pooler dependency). Dry-run by default; pass --apply to
 * mutate. Idempotent (a no-op once every override is ≤ MSRP).
 *
 * NOTE: deliberately NOT `_`-prefixed — `.gitignore` ignores `scripts/_*`, and this
 * sweep must be tracked so the build/worker commit picks it up before running it.
 *
 * Run: npx tsx scripts/backfill-drop-over-msrp-overrides.ts [--apply]
 * See docs/brain/specs/base-price-never-above-msrp.md.
 */
import { createAdminClient } from "./_bootstrap";
import { verifyMigration } from "../src/lib/migration-audit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISA_SUB_PREFIX = "fdc1d5e3";
const PAGE = 1000;

type Item = Record<string, unknown>;

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // 1. Page through every internal sub carrying any override.
  const subs: Array<{ id: string; customer_id: string | null; items: Item[] }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("subscriptions")
      .select("id, customer_id, items")
      .eq("is_internal", true)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`subscriptions read failed: ${error.message}`);
    if (!data?.length) break;
    for (const s of data) {
      const items = Array.isArray(s.items) ? (s.items as Item[]) : [];
      if (items.some((i) => Number(i.price_override_cents) > 0 && UUID_RE.test(String(i.variant_id || "")))) {
        subs.push({ id: String(s.id), customer_id: (s.customer_id as string) || null, items });
      }
    }
    if (data.length < PAGE) break;
  }
  console.log(`Scanned internal subs with a catalog-line override: ${subs.length}`);

  // 2. Resolve MSRP (product_variants.price_cents) for every referenced variant.
  const variantIds = [
    ...new Set(
      subs.flatMap((s) => s.items.map((i) => String(i.variant_id || "")).filter((v) => UUID_RE.test(v))),
    ),
  ];
  const msrpByVariant = new Map<string, number>();
  for (let i = 0; i < variantIds.length; i += PAGE) {
    const batch = variantIds.slice(i, i + PAGE);
    const { data, error } = await admin.from("product_variants").select("id, price_cents").in("id", batch);
    if (error) throw new Error(`product_variants read failed: ${error.message}`);
    for (const v of data || []) msrpByVariant.set(String(v.id), Number(v.price_cents) || 0);
  }

  // 3. Compute per-sub drops (override strictly > MSRP).
  const toFix: Array<{ id: string; customer_id: string | null; items: Item[]; dropped: string[] }> = [];
  for (const s of subs) {
    const dropped: string[] = [];
    const items = s.items.map((i) => {
      const vid = String(i.variant_id || "");
      const override = Number(i.price_override_cents);
      const msrp = msrpByVariant.get(vid) || 0;
      if (UUID_RE.test(vid) && override > 0 && msrp > 0 && override > msrp) {
        const { price_override_cents: _drop, ...rest } = i;
        void _drop;
        dropped.push(`${vid} ${override}¢>${msrp}¢`);
        return rest;
      }
      return i;
    });
    if (dropped.length) toFix.push({ id: s.id, customer_id: s.customer_id, items, dropped });
  }

  console.log(`Subs with an OVER-MSRP override to drop: ${toFix.length}\n`);
  for (const f of toFix) {
    const isLisa = f.id.startsWith(LISA_SUB_PREFIX) ? "  ← Lisa (fdc1d5e3)" : "";
    console.log(`  sub ${f.id}${isLisa}`);
    for (const d of f.dropped) console.log(`      drop override on ${d}`);
  }
  if (!toFix.some((f) => f.id.startsWith(LISA_SUB_PREFIX))) {
    console.log(`\n  (note: no sub starting ${LISA_SUB_PREFIX} found with an over-MSRP override — already repaired or different id)`);
  }

  if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to drop ${toFix.reduce((n, f) => n + f.dropped.length, 0)} override(s) across ${toFix.length} sub(s) and re-verify.`);
    return;
  }

  // 4. Write the dropped overrides + re-verify each affected sub's latest audit.
  let written = 0;
  for (const f of toFix) {
    const { error } = await admin.from("subscriptions").update({ items: f.items, updated_at: new Date().toISOString() }).eq("id", f.id);
    if (error) {
      console.log(`  ✗ sub ${f.id}: write failed — ${error.message}`);
      continue;
    }
    written++;

    const { data: audits } = await admin
      .from("migration_audits")
      .select("id, status")
      .eq("subscription_id", f.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const audit = audits?.[0];
    if (!audit) {
      console.log(`  ✓ sub ${f.id}: override(s) dropped (no migration_audit to re-verify)`);
      continue;
    }
    const verify = await verifyMigration(String(audit.id));
    console.log(`  ✓ sub ${f.id}: override(s) dropped → verifyMigration=${verify.status}`);
    for (const ch of verify.checks) {
      if (!ch.ok) console.log(`      FAIL ${ch.key}${ch.detail ? ` — ${ch.detail}` : ""}`);
    }
  }
  console.log(`\nDone: ${written}/${toFix.length} sub(s) repaired.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
