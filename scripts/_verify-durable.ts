import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,owner,parent_kind,parent_ref,parent").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").in("slug",["serialize-goal-member-spec-builds","refund-idempotency-guard-in-commerce-refund-facade"]);
  for(const s of data||[]) console.log(`✓ ${s.slug}\n    owner=${s.owner} parent_kind=${s.parent_kind} parent_ref=${s.parent_ref}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
