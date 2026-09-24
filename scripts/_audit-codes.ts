/** Every discount on every snapshot, by type and value shape — what we carry vs what we DROP. */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const snaps:any[]=[];
  for(let f=0;;f+=1000){
    const {data}=await admin.from("appstle_contract_snapshots")
      .select("appstle_contract_id,raw,migration_completed_at").eq("workspace_id",WS).range(f,f+999);
    if(!data?.length)break; snaps.push(...data); if(data.length<1000)break;
  }
  const kinds:Record<string,number>=({} as any);
  let withAny=0, carried=0, droppedPct=0, droppedExhausted=0;
  const pctExamples:string[]=[];
  for(const s of snaps){
    const nodes=(s.raw?.discounts?.nodes)??[];
    if(nodes.length) withAny++;
    let anyCarry=false, anyPct=false;
    for(const d of nodes){
      const type=String(d.type??"?");
      const v=d.value??{};
      const shape = v?.amount?.amount!=null ? "FIXED" : (v?.percentage!=null ? "PERCENTAGE" : "other");
      kinds[`${type}/${shape}`]=(kinds[`${type}/${shape}`]??0)+1;
      if(type!=="CODE_DISCOUNT") continue;
      const limit=(d.recurringCycleLimit as number|null)??null, used=Number(d.usageCount??0);
      if(limit!=null&&used>=limit){ droppedExhausted++; continue; }
      if(shape==="FIXED") anyCarry=true;
      else if(shape==="PERCENTAGE"){ anyPct=true; if(pctExamples.length<6) pctExamples.push(`${s.appstle_contract_id} "${d.title}" ${v.percentage}%${s.migration_completed_at?" (ALREADY MIGRATED — discount lost)":""}`); }
    }
    if(anyCarry) carried++;
    if(anyPct) droppedPct++;
  }
  console.log(`snapshots: ${snaps.length}   with ANY discount: ${withAny}`);
  console.log(`\ndiscount type/value shapes across the book:`);
  for(const [k,n] of Object.entries(kinds).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log(`\ncontracts with a carryable FIXED code : ${carried}`);
  console.log(`contracts with a PERCENTAGE code we DROP: ${droppedPct}  ⚠️`);
  console.log(`code instances dropped as exhausted     : ${droppedExhausted}`);
  if(pctExamples.length){ console.log(`\nexamples of dropped percentage codes:`); for(const e of pctExamples) console.log(`  ${e}`); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
