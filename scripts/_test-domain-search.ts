import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
async function post(path:string, body:any){
  const r=await fetch(`${BASE}${path}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify(body)});
  if(!r.ok) return `HTTP ${r.status}`;
  const j:any=await r.json(); const rows=j.data||j.list||j.results||[];
  return `${rows.length} ads (top advertisers: ${[...new Set(rows.slice(0,5).map((x:any)=>x.advertiser_name||x.page_name||x.advertiser))].join(", ")})`;
}
async function get(path:string){
  const r=await fetch(`${BASE}${path}`,{headers:{Authorization:`Bearer ${KEY}`}});
  if(!r.ok) return `HTTP ${r.status}`;
  const j:any=await r.json();
  const m=j.candidates?.meta?.slice(0,3).map((x:any)=>`"${x.name}"(${x.likes})`).join(" | ");
  return `best=${j.best_match?.meta?.name||"none"} cands: ${m||"none"}`;
}
(async()=>{
  console.log("search {keyword:'beam',domain}:", await post("/api/search",{keyword:"beam",appType:"3",geo:["USA"],domain:"shopbeam.com",pageSize:20})); await new Promise(r=>setTimeout(r,7000));
  console.log("search {domain only}:        ", await post("/api/search",{appType:"3",geo:["USA"],domain:"shopbeam.com",pageSize:20})); await new Promise(r=>setTimeout(r,7000));
  console.log("advertisers/search q=domain: ", await get("/api/advertisers/search?q=shopbeam.com&country=US")); await new Promise(r=>setTimeout(r,7000));
  console.log("advertisers/search q=Beam:   ", await get("/api/advertisers/search?q=Beam&country=US"));
})().then(()=>process.exit(0));
