// apply-enable-rls-flagged-tables-migration — enable RLS + service_role policy on
// the three tables Supabase's Security Advisor flagged (coupon_redemptions,
// checkout_errors, director_directives). Idempotent; verifies rowsecurity=true after.
//   npx tsx scripts/apply-enable-rls-flagged-tables-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260811130000_enable_rls_flagged_tables.sql";
const TABLES = ["coupon_redemptions", "checkout_errors", "director_directives"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows } = await c.query(
      `select t.tablename, t.rowsecurity,
              (select count(*) from pg_policies p
                where p.schemaname='public' and p.tablename=t.tablename) as policy_count
         from pg_tables t
        where t.schemaname='public' and t.tablename = any($1)
        order by t.tablename`,
      [TABLES],
    );
    for (const r of rows) {
      console.log(`✓ public.${r.tablename}: rls=${r.rowsecurity} policies=${r.policy_count}`);
    }
    const notEnabled = rows.filter((r) => !r.rowsecurity);
    if (rows.length !== TABLES.length || notEnabled.length) {
      throw new Error(
        `expected RLS enabled on all ${TABLES.length} tables; ` +
          `saw ${rows.length} row(s), ${notEnabled.length} still disabled`,
      );
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
