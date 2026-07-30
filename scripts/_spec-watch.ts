import { loadEnv, createAdminClient } from "./_bootstrap";
loadEnv();
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SPECS=[
 "journeys-enrolled-on-portal-so-sol-june-stop-wrong-escalating",
 "bianca-loser-kill-excludes-cold-scaler-adsets-plus-7day-grace",
 "security-review-lane-auto-requeues-on-transient-auth-error",
 "build-verify-reconciler-auto-applies-renames-and-moved-symbols",
 "repair-author-sanitizes-file-line-refs-from-intent-fields",
 "close-return-noop-on-null-shopify-return-gid",
];
const PARK=new Set(["needs_input","needs_approval","needs_attention","failed"]);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function tick(a:ReturnType<typeof createAdminClient>){
 const parked:string[]=[]; const done:string[]=[]; const building:string[]=[];
 for(const slug of SPECS){
   // spec phase rollup
   const {data:sp}=await a.from("specs").select("id,status").eq("workspace_id",WS).eq("slug",slug).maybeSingle();
   if(!sp){building.push(`${slug}:(no-row)`);continue;}
   const s:any=sp;
   const {data:ph}=await a.from("spec_phases").select("status").eq("spec_id",s.id);
   const allShipped=(ph||[]).length>0 && (ph||[]).every((p:any)=>p.status==="shipped");
   const folded=s.status==="folded";
   // latest job
   const {data:j}=await a.from("agent_jobs").select("kind,status").eq("workspace_id",WS).eq("spec_slug",slug).order("created_at",{ascending:false}).limit(1).maybeSingle();
   const js=(j as any)?.status, jk=(j as any)?.kind;
   if(js && PARK.has(js)){ parked.push(`${slug} → ${jk}/${js}`); }
   else if(allShipped||folded){ done.push(slug); }
   else { building.push(`${slug}:${jk||"-"}/${js||"-"}`); }
 }
 return {parked,done,building};
}
async function main(){
 const a=createAdminClient();
 const MAX_TICKS=96; // ~8h at 5min
 for(let i=0;i<MAX_TICKS;i++){
   let r; try{ r=await tick(a); }catch(e){ console.error(`[tick ${i}] transient: ${e instanceof Error?e.message:e}`); await sleep(300000); continue; }
   if(r.parked.length){ console.log(`WATCH-PARKED @tick${i}:\n  `+r.parked.join("\n  ")); console.log(`(done: ${r.done.length}/${SPECS.length}, building: ${r.building.length})`); return; }
   if(r.done.length===SPECS.length){ console.log(`WATCH-ALL-DONE: all ${SPECS.length} specs shipped/folded.`); return; }
   if(i%6===0) console.error(`[tick ${i}] done ${r.done.length}/${SPECS.length} · building ${r.building.length} · parked 0`);
   await sleep(300000);
 }
 console.log("WATCH-WINDOW-ENDED (8h): still building — re-arm if needed.");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("WATCH-FATAL "+(e instanceof Error?e.message:e));process.exit(1);});
