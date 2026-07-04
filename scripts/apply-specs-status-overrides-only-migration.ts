// apply-specs-status-overrides-only-migration — specs.status becomes {NULL, deferred, folded} only.
// `in_review` is retired as a STORED value; it is now DERIVED from the phase rollup + vale_review_passed_at
// (specs-status-overrides-only). Nulls existing in_review rows, drops the in_review default, and tightens the
// CHECK. Idempotent. MUST be applied AFTER the app code that maps in_review→NULL is live (else the old
// upsertSpec path writing status='in_review' would violate the new CHECK). Run against the pooler:
//   npx tsx scripts/apply-specs-status-overrides-only-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260907130000_specs_status_overrides_only_derive_in_review.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cc } = await c.query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname='specs_status_check'",
    );
    console.log(`✓ ${cc[0].def}`);
    const { rows: dist } = await c.query(
      "select coalesce(status,'(null)') as status, count(*)::int as n from public.specs group by 1 order by 2 desc",
    );
    console.log("✓ specs.status distribution:", dist.map((r) => `${r.status}=${r.n}`).join(", "));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
