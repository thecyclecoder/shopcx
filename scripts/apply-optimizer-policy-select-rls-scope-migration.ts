// apply-optimizer-policy-select-rls-scope-migration — tighten the Storefront Optimizer
// policy SELECT RLS from `auth.uid() is not null` (any authed user reads any workspace's
// policy) to workspace-member scope (optimizer-launch-hardening Phase 3, finding #5).
//
// Self-diagnosing by design (mirrors apply-storefront-optimizer-policy-migration): the box
// worker keeps only the LAST ~500 chars of output, so we apply the DDL statement-by-statement
// (a failure names the offending statement) and ALWAYS end with one compact `>>> APPLY
// RESULT: …` line. Idempotent (DROP POLICY IF EXISTS; CREATE POLICY). Run against the pooler:
//   npx tsx scripts/apply-optimizer-policy-select-rls-scope-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260629120000_optimizer_policy_select_rls_scope.sql";

/** Final compact verdict — printed to BOTH streams so the worker's slice(-500) always catches it. */
function verdict(line: string) {
  console.log(`>>> APPLY RESULT: ${line}`);
  console.error(`>>> APPLY RESULT: ${line}`);
}

/** Split a (function-body-free) migration into individual statements (strip `--` comments first). */
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

    // Confirm the live SELECT policy is now the workspace-member scope (no longer `auth.uid() is not null`).
    const { rows } = await c.query(
      `select qual from pg_policies
        where schemaname='public' and tablename='storefront_optimizer_policy'
          and policyname='storefront_optimizer_policy_select'`,
    );
    await c.end();
    if (!rows.length) {
      verdict(`SELECT policy missing after apply — expected storefront_optimizer_policy_select.`);
      process.exit(1);
    }
    const qual = String(rows[0].qual || "");
    if (!/workspace_members/.test(qual)) {
      verdict(`SELECT policy did NOT tighten — qual="${qual.slice(0, 120)}" (expected a workspace_members scope).`);
      process.exit(1);
    }
    verdict(`OK — storefront_optimizer_policy_select scoped to workspace members · qual="${qual.slice(0, 120)}"`);
  } catch (e) {
    verdict(`unexpected failure — ${pgTail(e)}`);
    await c.end().catch(() => {});
    process.exit(1);
  }
}

main();
