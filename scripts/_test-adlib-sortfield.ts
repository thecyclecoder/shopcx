import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
async function call(extra:any){
  const body={ keyword:"Obvi collagen", appType:"3", geo:["USA"], daysBack:90, pageSize:50, ...extra };
  const r=await fetch(`${BASE}/api/search`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify(body)});
  if(!r.ok) return `HTTP ${r.status}`;
  const j:any=await r.json();
  const rows=j.data||j.list||j.results||j.ads||(Array.isArray(j)?j:[]);
  const dc=(rows||[]).map((x:any)=>x.days_count||0);
  const imp=(rows||[]).map((x:any)=>x.impression||0);
  return `${(rows||[]).length} ads · days_count max=${Math.max(0,...dc)} top5=[${dc.slice(0,5).join(",")}] · impr max=${Math.max(0,...imp)}`;
}
(async()=>{
  for(const [label,extra] of [["default",{}],["sortField:impression",{sortField:"impression"}],["sortField:time",{sortField:"time"}],["sortField:like",{sortField:"like"}]] as any){
    try{ console.log(`${label}: ${await call(extra)}`);}catch(e:any){console.log(`${label}: ERR ${e.message}`);}
    await new Promise(r=>setTimeout(r,7000));
  }
})().then(()=>process.exit(0));
