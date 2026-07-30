import { loadEnv } from "./_bootstrap"; loadEnv();
import { investigateSpec, investigateGoal } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const s:any=await investigateSpec(WS, "dahlia-deeper-competitor-selection");
  console.log("=== spec ===");
  console.log(JSON.stringify({goal:s?.goal, milestone:s?.milestone, status:s?.status, parent:s?.parent, blockers:s?.blockers, job:s?.job||s?.activeJob},null,2).slice(0,900));
  const goalSlug = s?.goal?.slug || s?.goalSlug;
  if(goalSlug){
    const g:any=await investigateGoal(WS, goalSlug);
    console.log("\n=== goal:", goalSlug, "===");
    console.log(JSON.stringify(g?.members||g?.specs||g,null,2).slice(0,3000));
  } else { console.log("no goal slug on spec"); }
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
