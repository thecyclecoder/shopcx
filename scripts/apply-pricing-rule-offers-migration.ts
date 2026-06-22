// apply-pricing-rule-offers-migration — create the dynamic persist-to-renewal offer model
// (storefront-dynamic-renewal-offers spec, M6):
//   pricing_rule_offers        — scoped, time-boxed renewal-price override + status lifecycle
//   pricing_rule_offer_events  — append-only audit trail (a renewal-touching offer logs every
//                                state change)
//   subscriptions.pricing_rule_offer_id          — the live binding (reference, never a baked price)
//   storefront_optimizer_policy.renewal_margin_floor_pct — the configured margin floor
//   + seeds the `renewal_offer` lever into the M2 taxonomy.
//
// Self-diagnosing by design (mirrors apply-storefront-optimizer-policy-migration): the box
// worker keeps only the LAST ~500 chars of stdout+stderr, so we apply the DDL
// STATEMENT-BY-STATEMENT (a failure names the offending statement) and ALWAYS end with one
// compact `>>> APPLY RESULT: …` line. Idempotent throughout (CREATE … IF NOT EXISTS;
// ADD COLUMN IF NOT EXISTS; DROP/ADD CONSTRAINT IF EXISTS; on conflict do nothing). Run:
//   npx tsx scripts/apply-pricing-rule-offers-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260628120000_pricing_rule_offers.sql";

/** Final compact verdict — printed to BOTH streams so the worker's slice(-500) always catches it. */
function verdict(line: string) {
  console.log(`>>> APPLY RESULT: ${line}`);
  console.error(`>>> APPLY RESULT: ${line}`);
}

/**
 * Split a (function-body-free) migration into individual statements. Strips `--` line
 * comments first — this file has no `--` or `;` inside any string literal, so
 * comment-strip-then-split-on-`;` is exact here.
 */
function statements(sql: string): string[] {
  const noComments = sql
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Short pg-error tail for the captured window. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pgTail(e: any): string {
  const bits: string[] = [];
  if (e?.code) bits.push(`code=${e.code}`);
  if (e?.detail) bits.push(`detail=${String(e.detail).slice(0, 120)}`);
  if (e?.hint) bits.push(`hint=${String(e.hint).slice(0, 80)}`);
  if (e?.where) bits.push(`where=${String(e.where).slice(0, 80)}`);
  return bits.join(" · ") || (e?.message ? String(e.message).slice(0, 160) : String(e));
}

async function main() {
  const c = pgClient();
  try {
    await c.connect();
  } catch (e) {
    verdict(`connect failed — ${pgTail(e)}`);
    process.exit(1);
  }
  try {
    // ── DDL — one statement at a time so a failure names the offending statement ──
    const stmts = statements(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    for (let i = 0; i < stmts.length; i++) {
      const head = stmts[i].replace(/\s+/g, " ").slice(0, 70);
      try {
        await c.query(stmts[i]);
        console.log(`  ✓ [${i + 1}/${stmts.length}] ${head}`);
      } catch (e) {
        verdict(`DDL statement ${i + 1}/${stmts.length} FAILED — "${head}…" — ${pgTail(e)}`);
        await c.end().catch(() => {});
        process.exit(1);
      }
    }
    console.log(`✓ applied ${MIGRATION} (${stmts.length} statements)`);

    // ── Verify the shape landed ──────────────────────────────────────────────
    const { rows: offerCols } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
      ["pricing_rule_offers"],
    );
    const { rows: bind } = await c.query(
      "select 1 from information_schema.columns where table_schema='public' and table_name='subscriptions' and column_name='pricing_rule_offer_id'",
    );
    const { rows: floor } = await c.query(
      "select 1 from information_schema.columns where table_schema='public' and table_name='storefront_optimizer_policy' and column_name='renewal_margin_floor_pct'",
    );
    const { rows: lever } = await c.query(
      "select 1 from public.storefront_levers where lever_key='renewal_offer'",
    );
    await c.end();
    if (!bind.length || !floor.length) {
      verdict(`apply INCOMPLETE — pricing_rule_offers cols=${offerCols[0].n}, sub_binding=${!!bind.length}, margin_floor=${!!floor.length}`);
      process.exit(1);
    }
    verdict(
      `OK — pricing_rule_offers (${offerCols[0].n} cols) + pricing_rule_offer_events created · ` +
        `subscriptions.pricing_rule_offer_id ✓ · storefront_optimizer_policy.renewal_margin_floor_pct ✓ · ` +
        `renewal_offer lever seeded=${!!lever.length}`,
    );
  } catch (e) {
    await c.end().catch(() => {});
    verdict(`apply failed — ${pgTail(e)}`);
    process.exit(1);
  }
}
main().catch((e) => {
  verdict(`apply crashed — ${e?.message ?? e}`);
  process.exit(1);
});
