import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
async function search(body:any){
  const r=await fetch(`${BASE}/api/search`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify({appType:"3",geo:["USA"],pageSize:20,...body})});
  if(!r.ok) return `HTTP ${r.status}`;
  const j:any=await r.json(); const rows=j.data||j.list||j.results||[];
  const pages=[...new Set(rows.map((x:any)=>`${x.page_name||x.advertiser_name}(${x.page_id})`))].slice(0,4);
  return `${rows.length} ads · pages: ${pages.join(" | ")||"none"}`;
}
(async()=>{
  console.log("domain: 'wellah.com'      →", await search({domain:"wellah.com"})); await new Promise(r=>setTimeout(r,7000));
  console.log("keyword: 'wellah.com'     →", await search({keyword:"wellah.com"})); await new Promise(r=>setTimeout(r,7000));
  console.log("keyword: 'wellah'         →", await search({keyword:"wellah"})); await new Promise(r=>setTimeout(r,7000));
  console.log("keyword: 'wellah' +platform meta →", await search({keyword:"wellah",platform:["facebook","instagram"]}));
})().then(()=>process.exit(0));
