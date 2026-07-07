import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data}=await a.from("goals").select("slug,title,owner,status,is_parent").order("created_at",{ascending:false}).limit(15);
  for(const g of data||[]) console.log(`${(g.owner||'-').padEnd(24)} ${(g.status||'-').padEnd(10)} ${g.slug}`);
  const {data:f}=await a.from("functions").select("slug,name").limit(40).then((r:any)=>r).catch(()=>({data:null}));
  if(f) {console.log("\n=== functions table ==="); for(const x of f) console.log(`${x.slug}  —  ${x.name}`);}
}
main().catch(e=>{console.error(e.message);process.exit(1);});
