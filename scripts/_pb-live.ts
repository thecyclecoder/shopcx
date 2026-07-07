import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  try{ const {count}=await a.from("ticket_resolution_events").select("*",{count:"exact",head:true}); console.log("ticket_resolution_events rows:", count); }catch(e){console.log("ticket_resolution_events:", (e as any).message);}
  // playbooks: any created since the goal shipped (last 6h)?
  const cut=new Date(Date.now()-6*60*60*1000).toISOString();
  const {data:pb}=await a.from("playbooks").select("name,is_active,created_at").gte("created_at",cut).order("created_at",{ascending:false}).limit(10);
  console.log(`playbooks created in last 6h: ${(pb||[]).length}`); for(const p of pb||[]) console.log(`  ${p.is_active?'ACTIVE':'inactive'}  ${p.name}`);
  // total active playbooks (baseline)
  const {count:tot}=await a.from("playbooks").select("*",{count:"exact",head:true}).eq("is_active",true);
  console.log("total ACTIVE playbooks (existing):", tot);
}
main().catch(e=>{console.error(e.message);process.exit(1);});
