import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("specs").select("slug,parent_kind,parent_ref,owner").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").eq("parent_kind","mandate").limit(12);
  for(const s of data||[]) console.log(`  ${s.owner}\t${s.parent_ref}\t${s.slug.slice(0,36)}`);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
