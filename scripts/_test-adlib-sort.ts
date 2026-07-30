import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY;
const BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
async function call(extra:any){
  const body={ keyword:"Obvi collagen", appType:"3", geo:["USA"], daysBack:90, pageSize:20, ...extra };
  const r=await fetch(`${BASE}/api/search`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify(body)});
  if(!r.ok) return `HTTP ${r.status}`;
  const j:any=await r.json();
  const rows=j.data||j.results||j.ads||(Array.isArray(j)?j:[]);
  const days=(rows||[]).slice(0,8).map((x:any)=>x.days_count);
  const max=Math.max(...(rows||[]).map((x:any)=>x.days_count||0));
  return `${(rows||[]).length} ads · top8 days_count=[${days.join(",")}] · max=${max}`;
}
(async()=>{
  for(const [label,extra] of [["no sort",{}],["sort:'-days'",{sort:"-days"}],["sort:'-days_count'",{sort:"-days_count"}],["sortBy:'days',order:'desc'",{sortBy:"days",order:"desc"}],["activeStatus:'active',sort:'-days'",{activeStatus:"active",sort:"-days"}]] as any){
    try{ console.log(`${label}: ${await call(extra)}`);}catch(e:any){console.log(`${label}: ERR ${e.message}`);}
    await new Promise(r=>setTimeout(r,7000));
  }
})().then(()=>process.exit(0));
