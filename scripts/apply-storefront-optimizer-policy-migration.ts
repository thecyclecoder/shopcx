// apply-storefront-optimizer-policy-migration — create the Storefront Optimizer
// activation + product-scope gate table (storefront-optimizer-activation-gate spec, Phase 1):
//   storefront_optimizer_policy — per-workspace on-switch + enforced product_scope +
//                                 auto_run_reversible opt-in + editable guardrails.
// Then seeds the Superfoods workspace ON (propose-and-approve), scoped to Amazing Coffee.
//
// Self-diagnosing by design. The box worker runs this via `bash -lc` and keeps only the
// LAST ~500 chars of stdout+stderr as the result the owner sees — so a whole-file apply
// that fails names nothing and the Postgres error can scroll out of that window. Instead
// we apply the DDL STATEMENT-BY-STATEMENT (so the exact failing statement is named) and
// ALWAYS end with one compact `>>> APPLY RESULT: …` line carrying the verdict + (on
// failure) the pg code/detail/statement — guaranteed inside the captured window.
// Idempotent throughout (CREATE … IF NOT EXISTS; DROP POLICY IF EXISTS; the seed is
// `on conflict (workspace_id) do nothing`). Run against the pooler:
//   npx tsx scripts/apply-storefront-optimizer-policy-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260627120000_storefront_optimizer_policy.sql";
const AMAZING_COFFEE_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533";

/** Final compact verdict — printed to BOTH streams so the worker's slice(-500) always catches it. */
function verdict(line: string) {
  console.log(`>>> APPLY RESULT: ${line}`);
  console.error(`>>> APPLY RESULT: ${line}`);
}

/**
 * Split a (function-body-free) migration into individual statements. Strips `--` line
 * comments first — this file has semicolons inside comment lines, and no `--` or `;`
 * inside any string literal, so comment-strip-then-split-on-`;` is exact here.
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
    // ── 1. DDL — one statement at a time so a failure names the offending statement ──
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

    const { rows: cols } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
      ["storefront_optimizer_policy"],
    );
    console.log(`✓ public.storefront_optimizer_policy has ${cols[0].n} columns`);

    // ── 2. SEED — guarded + parameterized, isolated from the DDL ──────────────
    // Resolve the Superfoods workspace from the Amazing Coffee product row (no
    // hardcoded workspace id). Idempotent: skips if a policy already exists.
    const { rows: prod } = await c.query(
      "select workspace_id from public.products where id = $1",
      [AMAZING_COFFEE_ID],
    );
    if (!prod.length) {
      await c.end();
      verdict(
        `DDL ok (${cols[0].n} cols) — Amazing Coffee ${AMAZING_COFFEE_ID} not found, NO seed written ` +
          `(table default active=false ⇒ every workspace safely OFF).`,
      );
      return;
    }
    await c.query(
      `insert into public.storefront_optimizer_policy
         (workspace_id, active, product_scope, auto_run_reversible, created_by, rationale)
       values ($1, true, $2::jsonb, false, 'human', $3)
       on conflict (workspace_id) do nothing`,
      [
        prod[0].workspace_id,
        JSON.stringify([AMAZING_COFFEE_ID]),
        "Seed: optimizer ON in propose-and-approve mode, scoped to Amazing Coffee — proposes campaigns, owner taps Build to run each test.",
      ],
    );
    const { rows: seed } = await c.query(
      "select active, product_scope, auto_run_reversible from public.storefront_optimizer_policy where workspace_id = $1",
      [prod[0].workspace_id],
    );
    const r = seed[0];
    await c.end();
    verdict(
      `OK — public.storefront_optimizer_policy has ${cols[0].n} columns · seeded 1 active policy: ` +
        `active=${r.active}, product_scope=${JSON.stringify(r.product_scope)}, auto_run_reversible=${r.auto_run_reversible}`,
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
