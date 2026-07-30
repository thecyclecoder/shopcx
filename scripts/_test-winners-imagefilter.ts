import { loadEnv } from "./_bootstrap"; loadEnv();
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
const PAGE="2431731276838642"; // Obvi (cached = free)
async function scan(extra:any){
  const res=await fetch(`${BASE}/api/winners/advertiser/${PAGE}`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${KEY}`},body:JSON.stringify({country:"US",...extra})});
  const j:any=await res.json();
  const results=j.results||[];
  const media:Record<string,number>={}, plat:Record<string,number>={}, fmt:Record<string,number>={};
  for(const r of results){ const a=r.ad||{}; media[a.media_type||"?"]=(media[a.media_type||"?"]||0)+1; plat[a.platform||"?"]=(plat[a.platform||"?"]||0)+1; const f=r.score?.tags?.format||"?"; fmt[f]=(fmt[f]||0)+1; }
  return `${results.length} results · media=${JSON.stringify(media)} · platform=${JSON.stringify(plat)} · tag.format=${JSON.stringify(fmt)}`;
}
(async()=>{
  console.log("default:      ", await scan({}));
  await new Promise(r=>setTimeout(r,7000));
  console.log("adsType[1]:   ", await scan({adsType:["1"]}));
  await new Promise(r=>setTimeout(r,7000));
  console.log("media_type img:", await scan({media_type:"image"}));
})().then(()=>process.exit(0));
