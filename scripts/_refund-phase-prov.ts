import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
(async () => {
  const s = await getSpec("fdc11e10-b89f-4989-8b73-ed6526c4d906","refund-idempotency-guard-in-commerce-refund-facade");
  for (const p of (s as any)?.phases||[]) console.log(`- ${p.title?.slice(0,40)} | status=${p.status} | pr=${p.shipped_pr??p.pr_number??p.merged_pr??"-"} | sha=${(p.shipped_sha??p.merge_sha??"").slice(0,8)}`);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
